import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAccountUsage, fetchAccountUsage } from "../src/sub2api.ts";

const usageEnvelope = (data: unknown) => ({ code: 0, message: "success", data });

const realPayload = usageEnvelope({
  source: "passive",
  updated_at: "2026-10-10T15:18:09Z",
  five_hour: {
    utilization: 20,
    resets_at: "2026-10-11T03:50:00+08:00",
    remaining_seconds: 46000,
    used_requests: 12,
    limit_requests: 260,
  },
  seven_day: {
    utilization: 16,
    resets_at: "2026-10-11T12:00:00+08:00",
    remaining_seconds: 90000,
  },
});

test("parseAccountUsage parses the real passive payload", () => {
  const usage = parseAccountUsage(realPayload);
  assert.equal(usage.fiveHour?.utilization, 20);
  assert.equal(usage.fiveHour?.resetsAt, Date.parse("2026-10-11T03:50:00+08:00"));
  assert.equal(usage.sevenDay?.utilization, 16);
  assert.equal(usage.sevenDay?.resetsAt, Date.parse("2026-10-11T12:00:00+08:00"));
});

test("parseAccountUsage tolerates null windows and null resets_at", () => {
  const usage = parseAccountUsage(
    usageEnvelope({ five_hour: null, seven_day: { utilization: 3, resets_at: null } }),
  );
  assert.equal(usage.fiveHour, null);
  assert.equal(usage.sevenDay?.utilization, 3);
  assert.equal(usage.sevenDay?.resetsAt, null);
});

test("parseAccountUsage ignores unrelated sibling fields", () => {
  const usage = parseAccountUsage(
    usageEnvelope({
      five_hour: { utilization: 1, resets_at: null },
      seven_day: { utilization: 2, resets_at: null },
      seven_day_sonnet: { utilization: 99, resets_at: "2026-10-12T00:00:00Z" },
      grok_local_usage: { total: 5 },
    }),
  );
  assert.equal(usage.sevenDay?.utilization, 2);
});

test("parseAccountUsage rejects malformed envelopes", () => {
  for (const bad of [
    { code: 1, message: "internal error", data: null },
    { code: 0 },
    { code: 0, data: { five_hour: "nope" } },
    { code: 0, data: { five_hour: { utilization: "high", resets_at: null } } },
    { code: 0, data: { five_hour: { utilization: 1, resets_at: 42 } } },
    { code: 0, data: { seven_day: { utilization: 1, resets_at: "not-a-date" } } },
    null,
  ]) {
    assert.throws(() => parseAccountUsage(bad), Error, `should throw for ${JSON.stringify(bad)}`);
  }
});

const jsonResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

test("fetchAccountUsage builds the admin route with id and source query", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return jsonResponse(realPayload);
  }) as unknown as typeof fetch;
  const usage = await fetchAccountUsage({
    instanceBaseUrl: "http://h:8080",
    route: "/api/v1/admin/accounts/{id}/usage",
    method: "GET",
    token: "tok",
    accountId: 3589,
    usageSource: "passive",
    fetchImpl,
  });
  assert.equal(usage.fiveHour?.utilization, 20);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "http://h:8080/api/v1/admin/accounts/3589/usage?source=passive");
  assert.equal(calls[0]!.init.method, "GET");
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer tok");
  assert.equal(headers["User-Agent"], "pi-sub2api-usage/0.1.0");
});

test("fetchAccountUsage active source and POST method pass through", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return jsonResponse(realPayload);
  }) as unknown as typeof fetch;
  await fetchAccountUsage({
    instanceBaseUrl: "http://h:8080",
    route: "/api/v1/admin/accounts/{id}/usage",
    method: "POST",
    token: "t",
    accountId: 7,
    usageSource: "active",
    fetchImpl,
  });
  assert.equal(calls[0]!.url, "http://h:8080/api/v1/admin/accounts/7/usage?source=active");
  assert.equal(calls[0]!.init.method, "POST");
  assert.equal(calls[0]!.init.body, "{}");
});

test("fetchAccountUsage throws on non-2xx status", async () => {
  const fetchImpl = (async () => jsonResponse({ code: 0 }, 401)) as unknown as typeof fetch;
  await assert.rejects(
    fetchAccountUsage({
      instanceBaseUrl: "http://h",
      route: "/api/v1/admin/accounts/{id}/usage",
      method: "GET",
      token: "t",
      accountId: 1,
      usageSource: "passive",
      fetchImpl,
    }),
    /401/,
  );
});

test("fetchAccountUsage rejects when fetchImpl never settles before timeout", async () => {
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const signal = (init ?? {}).signal as AbortSignal | undefined;
    return new Promise((_resolve, reject) => {
      const keepalive = setTimeout(() => reject(new Error("keepalive expired")), 5000);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(keepalive);
          reject(signal.reason ?? new Error("aborted"));
        },
        { once: true },
      );
    });
  }) as unknown as typeof fetch;
  await assert.rejects(
    fetchAccountUsage({
      instanceBaseUrl: "http://h",
      route: "/api/v1/admin/accounts/{id}/usage",
      method: "GET",
      token: "t",
      accountId: 1,
      usageSource: "passive",
      timeoutMs: 30,
      fetchImpl,
    }),
  );
});
