import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../src/statusline.ts";
import extensionDefault from "../src/index.ts";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "sub2api-usage";

class ManualClock {
  private nowMs = 1_000_000;
  private timers: Array<{ due: number; fn: () => void; cleared: boolean }> = [];
  private nextId = 1;
  readonly now = (): number => this.nowMs;
  readonly setTimeoutImpl = (fn: () => void, ms: number): object => {
    const handle = {
      id: this.nextId++,
      due: this.nowMs + Math.max(0, ms),
      fn,
      cleared: false,
      unref: () => {},
      ref: () => {},
    };
    this.timers.push(handle as never);
    return handle;
  };
  readonly clearTimeoutImpl = (handle: object | undefined): void => {
    const timer = this.timers.find((t) => (t as unknown as { id?: number }).id === (handle as never as { id?: number })?.id);
    if (timer) timer.cleared = true;
  };
  advance(ms: number): void {
    this.nowMs += ms;
    const due = this.timers.filter((t) => !t.cleared && t.due <= this.nowMs);
    this.timers = this.timers.filter((t) => t.cleared || t.due > this.nowMs);
    for (const timer of due) timer.fn();
  }
}

const jsonResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

interface FetchCall {
  url: string;
  method: string;
  auth?: string;
}

type FetchStep = () => Promise<ReturnType<typeof jsonResponse>> | ReturnType<typeof jsonResponse>;

const scriptedFetch = (steps: FetchStep[]) => {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = ((init ?? {}).headers ?? {}) as Record<string, string>;
    calls.push({ url: String(url), method: String((init ?? {}).method), auth: headers.Authorization });
    const step = steps.shift();
    if (step === undefined) throw new Error("scripted fetch exhausted");
    return await step();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
};

const loginStep = (token: string, expiresIn = 3600) => () =>
  jsonResponse({ code: 0, message: "success", data: { access_token: token, expires_in: expiresIn } });

const quotaStep = (overrides: Record<string, unknown> = {}, status = 200) => () =>
  jsonResponse(
    {
      code: 0,
      message: "success",
      data: {
        platform_quotas: [
          {
            platform: "openai",
            daily_usage_usd: 6.2,
            daily_limit_usd: 10,
            daily_window_resets_at: "2026-10-11T00:00:00Z",
            weekly_usage_usd: 31,
            weekly_limit_usd: 100,
            weekly_window_resets_at: null,
            monthly_usage_usd: 12,
            monthly_limit_usd: 100,
            monthly_window_resets_at: null,
            ...overrides,
          },
        ],
      },
    },
    status,
  );

interface FixtureCtxUI {
  statuses: Array<string | undefined>;
  notifications: Array<{ message: string; level: string }>;
  setStatus: (key: string, value: string | undefined) => void;
  notify: (message: string, level: string) => void;
}

interface Fixture {
  agentDir: string;
  ctx: { ui: FixtureCtxUI; model: { provider: string } };
  clock: ManualClock;
  cleanup: () => void;
}

const makeFixture = (fetchImpl: typeof fetch): Fixture => {
  const agentDir = mkdtempSync(join(tmpdir(), "s2a-runtime-"));
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "sub2api-gpt": {
          api: "openai-responses",
          baseUrl: "http://s2a.test/v1",
          sub2api: true,
        },
        plain: { api: "openai-responses" },
      },
    }),
  );
  writeFileSync(
    join(agentDir, "pi-sub2api-usage.json"),
    JSON.stringify({ baseUrl: "http://s2a.test", email: "u@x.y", password: "pw" }),
  );
  const clock = new ManualClock();
  const statuses: Array<string | undefined> = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = {
    ui: {
      statuses,
      notifications,
      setStatus: (key: string, value: string | undefined) => {
        assert.equal(key, STATUS_KEY);
        statuses.push(value);
      },
      notify: (message: string, level: string) => {
        notifications.push({ message, level });
      },
    },
    model: { provider: "sub2api-gpt" },
  };
  return {
    agentDir,
    ctx,
    clock,
    cleanup: () => rmSync(agentDir, { recursive: true, force: true }),
  };
};

const settle = async (rounds = 6): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const runtimeOf = (fixture: Fixture, fetchImpl: typeof fetch) =>
  createRuntime({
    agentDir: fixture.agentDir,
    fetchImpl,
    now: fixture.clock.now,
    setTimeoutImpl: fixture.clock.setTimeoutImpl as unknown as typeof setTimeout,
    clearTimeoutImpl: fixture.clock.clearTimeoutImpl as unknown as typeof clearTimeout,
  });

test("model_select to marked provider publishes checking then chip; never writes usage key", async () => {
  const { fetchImpl, calls } = scriptedFetch([loginStep("tok-1"), quotaStep()]);
  const fixture = makeFixture(fetchImpl);
  const runtime = runtimeOf(fixture, fetchImpl);
  runtime.handleEvent(fixture.ctx as unknown as ExtensionContext, { provider: "sub2api-gpt" });
  await settle();
  const statuses = fixture.ctx.ui.statuses;
  assert.equal(statuses[0], "📊 sub2api-gpt checking");
  const last = statuses.at(-1)!;
  assert.ok(last.startsWith("📊 sub2api-gpt "), `unexpected chip: ${last}`);
  assert.ok(last.includes("%"), `chip lacks percent: ${last}`);
  assert.ok(calls.some((c) => c.url === "http://s2a.test/api/v1/user/platform-quotas"));
  fixture.cleanup();
});

test("second event within TTL re-publishes without fetching", async () => {
  const { fetchImpl, calls } = scriptedFetch([loginStep("tok-1"), quotaStep()]);
  const fixture = makeFixture(fetchImpl);
  const runtime = runtimeOf(fixture, fetchImpl);
  runtime.handleEvent(fixture.ctx as unknown as ExtensionContext, { provider: "sub2api-gpt" });
  await settle();
  const afterFirst = calls.length;
  const publishedOnce = fixture.ctx.ui.statuses.length;
  runtime.handleEvent(fixture.ctx as unknown as ExtensionContext, { provider: "sub2api-gpt" });
  await settle();
  assert.equal(calls.length, afterFirst);
  assert.ok(fixture.ctx.ui.statuses.length > publishedOnce);
  fixture.cleanup();
});

test("switching to unmarked provider clears the chip", async () => {
  const { fetchImpl } = scriptedFetch([loginStep("tok-1"), quotaStep()]);
  const fixture = makeFixture(fetchImpl);
  const runtime = runtimeOf(fixture, fetchImpl);
  runtime.handleEvent(fixture.ctx as unknown as ExtensionContext, { provider: "sub2api-gpt" });
  await settle();
  runtime.handleEvent(fixture.ctx as unknown as ExtensionContext, { provider: "plain" });
  await settle();
  assert.equal(fixture.ctx.ui.statuses.at(-1), undefined);
  fixture.cleanup();
});

test("401 on quota invalidates token, re-logins once, retries once", async () => {
  const { fetchImpl, calls } = scriptedFetch([
    loginStep("tok-1"),
    () => jsonResponse({ code: 0 }, 401),
    loginStep("tok-2"),
    quotaStep(),
  ]);
  const fixture = makeFixture(fetchImpl);
  const runtime = runtimeOf(fixture, fetchImpl);
  runtime.handleEvent(fixture.ctx as unknown as ExtensionContext, { provider: "sub2api-gpt" });
  await settle(10);
  const quotaCalls = calls.filter((c) => c.url.endsWith("/user/platform-quotas"));
  const loginCalls = calls.filter((c) => c.url.endsWith("/auth/login"));
  assert.equal(quotaCalls.length, 2);
  assert.equal(loginCalls.length, 2);
  assert.ok(fixture.ctx.ui.statuses.at(-1)!.includes("%"));
  fixture.cleanup();
});

test("persistent 401 caps retries and shows error chip", async () => {
  const { fetchImpl, calls } = scriptedFetch([
    loginStep("tok-1"),
    () => jsonResponse({ code: 0 }, 401),
    loginStep("tok-2"),
    () => jsonResponse({ code: 0 }, 401),
  ]);
  const fixture = makeFixture(fetchImpl);
  const runtime = runtimeOf(fixture, fetchImpl);
  runtime.handleEvent(fixture.ctx as unknown as ExtensionContext, { provider: "sub2api-gpt" });
  await settle(10);
  assert.equal(calls.filter((c) => c.url.endsWith("/user/platform-quotas")).length, 2);
  const last = fixture.ctx.ui.statuses.at(-1)!;
  assert.ok(last.startsWith("📊 sub2api-gpt error:"), `unexpected chip: ${last}`);
  fixture.cleanup();
});

test("login rejection maps to error chip with backoff", async () => {
  const { fetchImpl, calls } = scriptedFetch([
    () => jsonResponse({ code: 1, message: "invalid credentials" }),
    () => jsonResponse({ code: 1, message: "invalid credentials" }),
  ]);
  const fixture = makeFixture(fetchImpl);
  const runtime = runtimeOf(fixture, fetchImpl);
  runtime.handleEvent(fixture.ctx as unknown as ExtensionContext, { provider: "sub2api-gpt" });
  await settle();
  assert.ok(fixture.ctx.ui.statuses.at(-1)!.startsWith("📊 sub2api-gpt error:"));
  runtime.handleEvent(fixture.ctx as unknown as ExtensionContext, { provider: "sub2api-gpt" });
  await settle();
  assert.equal(calls.length, 1, "backoff should prevent an immediate second login");
  fixture.cleanup();
});

test("quota response without the platform shows no quota", async () => {
  const { fetchImpl } = scriptedFetch([
    loginStep("tok-1"),
    () =>
      jsonResponse({
        code: 0,
        data: { platform_quotas: [{ platform: "gemini", daily_usage_usd: 1, weekly_usage_usd: 1, monthly_usage_usd: 1 }] },
      }),
  ]);
  const fixture = makeFixture(fetchImpl);
  const runtime = runtimeOf(fixture, fetchImpl);
  runtime.handleEvent(fixture.ctx as unknown as ExtensionContext, { provider: "sub2api-gpt" });
  await settle();
  assert.equal(fixture.ctx.ui.statuses.at(-1), "📊 sub2api-gpt no quota");
  fixture.cleanup();
});

test("stale in-flight result is discarded on provider switch", async () => {
  let releaseQuota: ((value: void) => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseQuota = resolve;
  });
  const { fetchImpl } = scriptedFetch([
    loginStep("tok-1"),
    async () => {
      await gate;
      return quotaStep()();
    },
  ]);
  const fixture = makeFixture(fetchImpl);
  const runtime = runtimeOf(fixture, fetchImpl);
  runtime.handleEvent(fixture.ctx as unknown as ExtensionContext, { provider: "sub2api-gpt" });
  await settle();
  assert.deepEqual(fixture.ctx.ui.statuses, ["📊 sub2api-gpt checking"]);
  runtime.handleEvent(fixture.ctx as unknown as ExtensionContext, { provider: "plain" });
  await settle();
  assert.deepEqual(fixture.ctx.ui.statuses, ["📊 sub2api-gpt checking", undefined]);
  releaseQuota?.();
  await settle();
  assert.deepEqual(fixture.ctx.ui.statuses, ["📊 sub2api-gpt checking", undefined]);
  fixture.cleanup();
});

test("countdown re-render republishes every 60s without fetching", async () => {
  const { fetchImpl, calls } = scriptedFetch([loginStep("tok-1"), quotaStep()]);
  const fixture = makeFixture(fetchImpl);
  const runtime = runtimeOf(fixture, fetchImpl);
  runtime.handleEvent(fixture.ctx as unknown as ExtensionContext, { provider: "sub2api-gpt" });
  await settle();
  const callsBefore = calls.length;
  const statusesBefore = fixture.ctx.ui.statuses.length;
  fixture.clock.advance(60_000);
  await settle();
  assert.equal(calls.length, callsBefore);
  assert.equal(fixture.ctx.ui.statuses.length, statusesBefore + 1);
  fixture.cleanup();
});

test("broken settings file warns once and shows no credentials chip", async () => {
  const { fetchImpl } = scriptedFetch([]);
  const fixture = makeFixture(fetchImpl);
  writeFileSync(join(fixture.agentDir, "pi-sub2api-usage.json"), "{nope");
  const runtime = runtimeOf(fixture, fetchImpl);
  runtime.handleEvent(fixture.ctx as unknown as ExtensionContext, { provider: "sub2api-gpt" });
  await settle();
  runtime.handleEvent(fixture.ctx as unknown as ExtensionContext, { provider: "sub2api-gpt" });
  await settle();
  assert.equal(fixture.ctx.ui.notifications.length, 1);
  assert.equal(fixture.ctx.ui.notifications[0]!.level, "warning");
  assert.equal(fixture.ctx.ui.statuses.at(-1), "📊 sub2api-gpt error: no credentials");
  fixture.cleanup();
});

test("shutdown clears timers and is repeatable", async () => {
  const { fetchImpl } = scriptedFetch([loginStep("tok-1"), quotaStep()]);
  const fixture = makeFixture(fetchImpl);
  const runtime = runtimeOf(fixture, fetchImpl);
  runtime.handleEvent(fixture.ctx as unknown as ExtensionContext, { provider: "sub2api-gpt" });
  await settle();
  const statusesAfterPublish = fixture.ctx.ui.statuses.length;
  runtime.shutdown(fixture.ctx as unknown as ExtensionContext);
  runtime.shutdown(fixture.ctx as unknown as ExtensionContext);
  assert.equal(fixture.ctx.ui.statuses.at(-1), undefined);
  fixture.clock.advance(120_000);
  await settle();
  assert.equal(fixture.ctx.ui.statuses.length, statusesAfterPublish + 2); // two shutdowns clear twice
  fixture.cleanup();
});

test("runManualCheck forces a query and notifies raw JSON", async () => {
  const { fetchImpl, calls } = scriptedFetch([
    loginStep("tok-1"),
    quotaStep(),
    loginStep("tok-2"),
    quotaStep(),
  ]);
  const fixture = makeFixture(fetchImpl);
  const runtime = runtimeOf(fixture, fetchImpl);
  runtime.handleEvent(fixture.ctx as unknown as ExtensionContext, { provider: "sub2api-gpt" });
  await settle();
  const callsBefore = calls.length;
  await runtime.runManualCheck(fixture.ctx as unknown as ExtensionCommandContext);
  assert.ok(calls.length > callsBefore, "manual check must bypass the quota cache");
  const notified = fixture.ctx.ui.notifications.find((n) => n.message.includes("platform_quotas"));
  assert.ok(notified !== undefined, "notify should include raw JSON");
  fixture.cleanup();
});

test("index registers command and events on the ExtensionAPI", async () => {
  const events = new Map<string, (event: unknown, ctx: unknown) => void | Promise<void>>();
  const commands = new Map<string, unknown>();
  const pi = {
    on: (name: string, callback: (event: unknown, ctx: unknown) => void | Promise<void>) => {
      events.set(name, callback);
    },
    registerCommand: (name: string, definition: unknown) => {
      commands.set(name, definition);
    },
  } as unknown as ExtensionAPI;
  extensionDefault(pi);
  for (const name of ["session_start", "session_tree", "model_select", "turn_start", "session_shutdown"]) {
    assert.ok(events.has(name), `missing event handler for ${name}`);
  }
  assert.equal(commands.size, 1);
  assert.ok(commands.has("sub2api-usage"));
  const definition = commands.get("sub2api-usage") as { handler: (args: string, ctx: unknown) => Promise<void> };
  assert.equal(typeof definition.handler, "function");
});
