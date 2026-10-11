import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuthError,
  login,
  obtainAccessToken,
  readTokenCache,
  writeTokenCache,
} from "../src/auth.ts";
import { normalizeSettings } from "../src/settings.ts";

const jsonResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const tempCachePath = (content?: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "s2a-auth-"));
  const path = join(dir, "pi-sub2api-usage-cache.json");
  if (content !== undefined) writeFileSync(path, content);
  return path;
};

const loginEnvelope = (data: unknown) => ({ code: 0, message: "success", data });

test("manual token takes precedence and skips fetch", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return jsonResponse({});
  }) as unknown as typeof fetch;
  const state = await obtainAccessToken({
    settings: normalizeSettings({ token: "t" }),
    cachePath: tempCachePath(),
    fetchImpl,
  });
  assert.deepEqual(state, { accessToken: "t", expiresAt: Infinity });
  assert.equal(calls, 0);
});

test("valid cached token is reused without login", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return jsonResponse({});
  }) as unknown as typeof fetch;
  const now = 1_000_000;
  const cachePath = tempCachePath(JSON.stringify({ accessToken: "cached", expiresAt: now + 120_000 }));
  const state = await obtainAccessToken({ settings: normalizeSettings({}), cachePath, now, fetchImpl });
  assert.equal(state.accessToken, "cached");
  assert.equal(calls, 0);
});

test("cached token inside the 60s margin triggers login", async () => {
  const now = 1_000_000;
  const cachePath = tempCachePath(JSON.stringify({ accessToken: "stale", expiresAt: now + 30_000 }));
  const state = await obtainAccessToken({
    settings: normalizeSettings({ email: "a@b.c", password: "p", baseUrl: "http://h:8080" }),
    cachePath,
    now,
    fetchImpl: (async () =>
      jsonResponse(loginEnvelope({ access_token: "fresh", expires_in: 3600 }))) as unknown as typeof fetch,
  });
  assert.equal(state.accessToken, "fresh");
  assert.equal(state.expiresAt, now + 3_600_000);
});

test("login happy path persists cache with mode 0600", async () => {
  const now = 5_000_000;
  const cachePath = tempCachePath();
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const state = await obtainAccessToken({
    settings: normalizeSettings({ email: "a@b.c", password: "p", baseUrl: "https://example.test" }),
    cachePath,
    now,
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return jsonResponse(loginEnvelope({ access_token: "abc", expires_in: 3600 }));
    }) as unknown as typeof fetch,
  });
  assert.deepEqual(state, { accessToken: "abc", expiresAt: now + 3_600_000 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://example.test/api/v1/auth/login");
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers["User-Agent"], "pi-sub2api-usage/0.1.0");
  assert.deepEqual(JSON.parse(calls[0]!.init.body as string), { email: "a@b.c", password: "p" });
  const persisted = JSON.parse(readFileSync(cachePath, "utf8"));
  assert.deepEqual(persisted, { accessToken: "abc", expiresAt: now + 3_600_000 });
  assert.equal(statSync(cachePath).mode & 0o777, 0o600);
});

test("login with baseUrl from settings, requires_2fa raises AuthError 2fa", async () => {
  const now = 9_000_000;
  const state = await obtainAccessToken({
    settings: normalizeSettings({
      email: "a@b.c",
      password: "p",
      baseUrl: "http://h:8080",
    }),
    cachePath: tempCachePath(),
    now,
    fetchImpl: (async () =>
      jsonResponse(
        loginEnvelope({ requires_2fa: true, temp_token: "tmp", user_email_masked: "a***@b.c" }),
      )) as unknown as typeof fetch,
  }).catch((error: unknown) => {
    assert.ok(error instanceof AuthError);
    assert.equal(error.kind, "2fa");
    return undefined;
  });
  assert.equal(state, undefined);
});

test("missing expires_in yields immediately-stale token", async () => {
  const now = 7_000_000;
  const state = await login({
    instanceBaseUrl: "http://h:8080",
    email: "a@b.c",
    password: "p",
    now,
    fetchImpl: (async () =>
      jsonResponse(loginEnvelope({ access_token: "x" }))) as unknown as typeof fetch,
  });
  assert.deepEqual(state, { accessToken: "x", expiresAt: now });
});

test("captcha-ish envelope message maps to captcha kind", async () => {
  await assert.rejects(
    login({
      instanceBaseUrl: "http://h:8080",
      email: "a@b.c",
      password: "p",
      fetchImpl: (async () => jsonResponse({ code: 1, message: "captcha required" })) as unknown as typeof fetch,
    }),
    (error: unknown) => {
      assert.ok(error instanceof AuthError);
      assert.equal((error as AuthError).kind, "captcha");
      return true;
    },
  );
});

test("other envelope failures map to login-failed", async () => {
  for (const body of [
    { code: 1, message: "invalid credentials" },
    { code: 1, message: "unauthorized" },
  ]) {
    await assert.rejects(
      login({
        instanceBaseUrl: "http://h:8080",
        email: "a@b.c",
        password: "p",
        fetchImpl: (async () => jsonResponse(body)) as unknown as typeof fetch,
      }),
      (error: unknown) => {
        assert.ok(error instanceof AuthError);
        assert.equal((error as AuthError).kind, "login-failed");
        return true;
      },
    );
  }
});

test("HTTP 401 on login maps to login-failed", async () => {
  await assert.rejects(
    login({
      instanceBaseUrl: "http://h:8080",
      email: "a@b.c",
      password: "p",
      fetchImpl: (async () => jsonResponse({ code: 0 }, 401)) as unknown as typeof fetch,
    }),
    (error: unknown) => {
      assert.ok(error instanceof AuthError);
      assert.equal((error as AuthError).kind, "login-failed");
      return true;
    },
  );
});

test("missing email+password+token raises no-credentials without fetch", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return jsonResponse({});
  }) as unknown as typeof fetch;
  await assert.rejects(
    obtainAccessToken({ settings: normalizeSettings({}), cachePath: tempCachePath(), fetchImpl }),
    (error: unknown) => {
      assert.ok(error instanceof AuthError);
      assert.equal((error as AuthError).kind, "no-credentials");
      return true;
    },
  );
  assert.equal(calls, 0);
});

test("readTokenCache returns undefined for garbage or missing cache", () => {
  assert.equal(readTokenCache(tempCachePath()), undefined);
  assert.equal(readTokenCache(tempCachePath("{nope")), undefined);
  assert.deepEqual(readTokenCache(tempCachePath(JSON.stringify({ accessToken: "a", expiresAt: 5 }))), {
    accessToken: "a",
    expiresAt: 5,
  });
});

test("writeTokenCache writes JSON readable back", () => {
  const path = tempCachePath();
  writeTokenCache(path, { accessToken: "z", expiresAt: 42 });
  assert.deepEqual(readTokenCache(path), { accessToken: "z", expiresAt: 42 });
  rmSync(join(path, ".."), { recursive: true, force: true });
});
