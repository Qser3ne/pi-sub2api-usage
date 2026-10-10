import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlatformQuotas, fetchQuotas, findQuota } from "../src/sub2api.ts";

const rawRecord = {
  platform: "openai",
  daily_usage_usd: 6.2,
  daily_limit_usd: 10,
  daily_window_resets_at: "2026-10-11T00:00:00+08:00",
  weekly_usage_usd: 31,
  weekly_limit_usd: 100,
  weekly_window_resets_at: null,
  monthly_usage_usd: 12,
  monthly_limit_usd: null,
  monthly_window_resets_at: null,
};

const envelope = (quotas: unknown[]) => ({ code: 0, message: "success", data: { platform_quotas: quotas } });

test("parsePlatformQuotas parses spec field names with null semantics", () => {
  const quotas = parsePlatformQuotas(envelope([rawRecord]));
  assert.equal(quotas.length, 1);
  const q = quotas[0]!;
  assert.equal(q.platform, "openai");
  assert.equal(q.daily.usageUsd, 6.2);
  assert.equal(q.daily.limitUsd, 10);
  assert.equal(q.daily.resetsAt, Date.parse("2026-10-11T00:00:00+08:00"));
  assert.equal(q.weekly.resetsAt, null);
  assert.equal(q.monthly.limitUsd, null);
  assert.equal(q.monthly.usageUsd, 12);
});

test("parsePlatformQuotas ignores unknown fields and treats missing limit/reset as null", () => {
  const quotas = parsePlatformQuotas(
    envelope([{ platform: "anthropic", daily_usage_usd: 1, weekly_usage_usd: 2, monthly_usage_usd: 3, extra: "x" }]),
  );
  const q = quotas[0]!;
  assert.equal(q.daily.limitUsd, null);
  assert.equal(q.daily.resetsAt, null);
});

test("parsePlatformQuotas rejects malformed envelopes", () => {
  for (const bad of [
    { code: 1, message: "boom", data: { platform_quotas: [] } },
    { code: 0 },
    { code: 0, data: {} },
    { code: 0, data: { platform_quotas: "nope" } },
    envelope([{ platform: "x", daily_usage_usd: "lots" }]),
    envelope([{ platform: "x", daily_limit_usd: "10" }]),
    envelope([{ platform: "x", daily_window_resets_at: 42 }]),
    envelope([{ platform: 7, daily_usage_usd: 1 }]),
    envelope([{ daily_usage_usd: 1 }]),
  ]) {
    assert.throws(() => parsePlatformQuotas(bad), Error, `should throw for ${JSON.stringify(bad)}`);
  }
});

const jsonResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

test("fetchQuotas GET sends auth, UA, and route and parses quotas", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return jsonResponse(envelope([rawRecord]));
  }) as typeof fetch;
  const quotas = await fetchQuotas({
    instanceBaseUrl: "http://h:8080",
    route: "/api/v1/user/platform-quotas",
    method: "GET",
    token: "tok",
    fetchImpl,
  });
  assert.equal(quotas.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "http://h:8080/api/v1/user/platform-quotas");
  assert.equal(calls[0]!.init.method, "GET");
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer tok");
  assert.equal(headers["User-Agent"], "pi-sub2api-usage/0.1.0");
});

test("fetchQuotas POST sends empty object body", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return jsonResponse(envelope([]));
  }) as typeof fetch;
  await fetchQuotas({
    instanceBaseUrl: "http://h:8080",
    route: "/q",
    method: "POST",
    token: "t",
    fetchImpl,
  });
  assert.equal(calls[0]!.init.method, "POST");
  assert.equal(calls[0]!.init.body, "{}");
});

test("fetchQuotas throws on non-2xx status", async () => {
  const fetchImpl = (async () => jsonResponse({ code: 0 }, 401)) as unknown as typeof fetch;
  await assert.rejects(
    fetchQuotas({ instanceBaseUrl: "http://h", route: "/q", method: "GET", token: "t", fetchImpl }),
    /401/,
  );
});

test("fetchQuotas rejects when fetchImpl never settles before timeout", async () => {
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const signal = (init ?? {}).signal as AbortSignal | undefined;
    return new Promise((_resolve, reject) => {
      // Ref'd keepalive so the event loop stays alive until the (unref'd) abort fires.
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
    fetchQuotas({
      instanceBaseUrl: "http://h",
      route: "/q",
      method: "GET",
      token: "t",
      timeoutMs: 30,
      fetchImpl,
    }),
  );
});

test("findQuota matches by platform", () => {
  const quotas = parsePlatformQuotas(
    envelope([rawRecord, { platform: "anthropic", daily_usage_usd: 0, weekly_usage_usd: 0, monthly_usage_usd: 0 }]),
  );
  assert.equal(findQuota(quotas, "anthropic")?.platform, "anthropic");
  assert.equal(findQuota(quotas, "gemini"), undefined);
});
