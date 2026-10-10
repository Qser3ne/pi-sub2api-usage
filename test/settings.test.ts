import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeSettings,
  loadSettings,
  loadModelsProviders,
  resolveProviderTarget,
  type ProviderResolution,
  type ResolvedTarget,
} from "../src/settings.ts";

const asTarget = (resolution: ProviderResolution): ResolvedTarget => {
  assert.ok(typeof resolution === "object", `expected ResolvedTarget, got ${String(resolution)}`);
  return resolution;
};

const tempAgentDir = (files: Record<string, string> = {}): string => {
  const dir = mkdtempSync(join(tmpdir(), "s2a-settings-"));
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
};

test("normalizeSettings applies all defaults for empty object", () => {
  const s = normalizeSettings({});
  assert.equal(s.route, "/api/v1/user/platform-quotas");
  assert.equal(s.method, "GET");
  assert.deepEqual(s.platformMap, {});
  assert.equal(s.refreshMs, 300000);
  assert.equal(s.baseUrl, undefined);
  assert.equal(s.email, undefined);
  assert.equal(s.password, undefined);
  assert.equal(s.token, undefined);
});

test("normalizeSettings round-trips provided values", () => {
  const s = normalizeSettings({
    baseUrl: "http://h",
    email: "e",
    password: "p",
    token: "t",
    route: "/x",
    method: "POST",
    refreshMs: 1000,
    platformMap: { a: "b" },
  });
  assert.equal(s.baseUrl, "http://h");
  assert.equal(s.email, "e");
  assert.equal(s.password, "p");
  assert.equal(s.token, "t");
  assert.equal(s.route, "/x");
  assert.equal(s.method, "POST");
  assert.equal(s.refreshMs, 1000);
  assert.deepEqual(s.platformMap, { a: "b" });
});

test("normalizeSettings falls back per-field on invalid values", () => {
  const s = normalizeSettings({ method: "PUT", refreshMs: "fast", route: 42 });
  assert.equal(s.method, "GET");
  assert.equal(s.refreshMs, 300000);
  assert.equal(s.route, "/api/v1/user/platform-quotas");
});

test("normalizeSettings handles non-object raw input", () => {
  for (const raw of [null, undefined, "x", 7]) {
    const s = normalizeSettings(raw);
    assert.equal(s.route, "/api/v1/user/platform-quotas");
    assert.equal(s.method, "GET");
    assert.equal(s.refreshMs, 300000);
  }
});

test("normalizeSettings clamps negative and non-positive refreshMs", () => {
  assert.equal(normalizeSettings({ refreshMs: -5 }).refreshMs, 300000);
  assert.equal(normalizeSettings({ refreshMs: 0 }).refreshMs, 300000);
});

test("loadSettings parses a valid file", () => {
  const dir = tempAgentDir({
    "pi-sub2api-usage.json": JSON.stringify({ baseUrl: "http://h:8080", email: "a@b.c" }),
  });
  const { settings, broken } = loadSettings(dir);
  assert.equal(broken, false);
  assert.equal(settings.baseUrl, "http://h:8080");
  assert.equal(settings.email, "a@b.c");
  rmSync(dir, { recursive: true, force: true });
});

test("loadSettings returns defaults when file is missing", () => {
  const dir = tempAgentDir();
  const { settings, broken } = loadSettings(dir);
  assert.equal(broken, false);
  assert.equal(settings.route, "/api/v1/user/platform-quotas");
  rmSync(dir, { recursive: true, force: true });
});

test("loadSettings flags broken JSON and uses defaults", () => {
  const dir = tempAgentDir({ "pi-sub2api-usage.json": "{nope" });
  const { settings, broken } = loadSettings(dir);
  assert.equal(broken, true);
  assert.equal(settings.route, "/api/v1/user/platform-quotas");
  rmSync(dir, { recursive: true, force: true });
});

test("loadModelsProviders reads marked providers", () => {
  const dir = tempAgentDir({
    "models.json": JSON.stringify({
      providers: { p1: { api: "anthropic-messages", baseUrl: "http://h:8080", sub2api: true } },
    }),
  });
  const providers = loadModelsProviders(dir);
  assert.deepEqual(providers.p1, { api: "anthropic-messages", baseUrl: "http://h:8080", sub2api: true });
  rmSync(dir, { recursive: true, force: true });
});

test("loadModelsProviders tolerates missing/invalid models.json", () => {
  const cases: Array<Record<string, string>> = [
    {},
    { "models.json": "{bad" },
    { "models.json": JSON.stringify({ providers: "nope" }) },
  ];
  for (const files of cases) {
    const dir = tempAgentDir(files);
    assert.deepEqual(loadModelsProviders(dir), {});
    rmSync(dir, { recursive: true, force: true });
  }
});

const providers = {
  "sub2api-claude": { api: "anthropic-messages", baseUrl: "http://h:8080", sub2api: true },
  "sub2api-gpt": { api: "openai-responses", baseUrl: "http://h:8080/v1", sub2api: true },
  plain: { api: "anthropic-messages", baseUrl: "http://h:8080" },
};
const baseSettings = normalizeSettings({});

test("resolveProviderTarget derives anthropic platform and baseUrl", () => {
  assert.deepEqual(resolveProviderTarget("sub2api-claude", providers, baseSettings), {
    providerId: "sub2api-claude",
    platform: "anthropic",
    instanceBaseUrl: "http://h:8080",
  });
});

test("resolveProviderTarget derives openai platform and strips /v1", () => {
  assert.deepEqual(resolveProviderTarget("sub2api-gpt", providers, baseSettings), {
    providerId: "sub2api-gpt",
    platform: "openai",
    instanceBaseUrl: "http://h:8080",
  });
});

test("resolveProviderTarget lets platformMap override derivation", () => {
  const settings = normalizeSettings({ platformMap: { "sub2api-gpt": "gemini" } });
  assert.equal(asTarget(resolveProviderTarget("sub2api-gpt", providers, settings)).platform, "gemini");
});

test("resolveProviderTarget returns unmarked for unmarked or unknown providers", () => {
  assert.equal(resolveProviderTarget("plain", providers, baseSettings), "unmarked");
  assert.equal(resolveProviderTarget("missing", providers, baseSettings), "unmarked");
  assert.equal(resolveProviderTarget(undefined, providers, baseSettings), "unmarked");
});

test("resolveProviderTarget flags marked provider with unknown platform", () => {
  const odd = { odd: { api: "google-gemini", sub2api: true } };
  assert.equal(resolveProviderTarget("odd", odd, baseSettings), "no-platform");
});

test("resolveProviderTarget flags marked provider without any baseUrl", () => {
  const noBase = { nb: { api: "anthropic-messages", sub2api: true } };
  assert.equal(resolveProviderTarget("nb", noBase, baseSettings), "no-base-url");
});

test("resolveProviderTarget prefers settings baseUrl over provider baseUrl", () => {
  const settings = normalizeSettings({ baseUrl: "http://elsewhere:9" });
  const target = asTarget(resolveProviderTarget("sub2api-claude", providers, settings));
  assert.equal(target.instanceBaseUrl, "http://elsewhere:9");
});
