# pi-sub2api-usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local pi extension that displays sub2api platform-quota usage in the statusline for models.json providers marked `"sub2api": true`, coexisting with pi-usage and rendering through pi-statusline.

**Architecture:** Independent extension publishing one chip under its own status key `sub2api-usage` via `ctx.ui.setStatus`. Refresh pipeline mirrors pi-usage's lifecycle (session_start/session_tree/model_select/turn_start, 5-min cache, 30s failure backoff, 60s countdown re-render, generation guard). Auth = panel email/password auto-login minting access tokens, cached on disk; a manual `token` setting overrides. Pure modules (settings/parse/format) are dependency-injected (`fetchImpl`, `now`, fs paths) for unit tests.

**Tech Stack:** TypeScript (erasable syntax only — no enums/namespaces, `import type` for types), Node >= 22.6 runtime with `node --experimental-strip-types --test`, zero runtime dependencies, `@earendil-works/pi-coding-agent` as peer (host-provided).

**Spec:** `docs/superpowers/specs/2026-10-10-pi-sub2api-usage-design.md`

## Global Constraints

- Status key is exactly `sub2api-usage`; chip value begins with `"📊 "`. Never write to status key `usage` (pi-usage's).
- No runtime dependencies. `peerDependencies`: `"@earendil-works/pi-coding-agent": "*"`.
- Package manifest: `"pi": { "extensions": ["./src/index.ts"] }`; `"type": "module"`.
- Erasable TS only: no `enum`, no namespaces, no parameter properties; type-only imports use `import type`.
- Test command: `node --experimental-strip-types --test test/*.test.ts` (from repo root). Typecheck: `npx tsc --noEmit`.
- Constants (spec-verbatim): HTTP timeout 15_000ms; `refreshMs` default 300_000; failure backoff 30_000ms; countdown re-render 60_000ms; token validity margin 60s; chip truncation 80 chars; error chip prefix `error:`; auth-missing chip `no credentials`; no-record chip `no quota`; checking chip `checking`.
- Login route fixed `POST {baseUrl}/api/v1/auth/login`; default quota route `/api/v1/user/platform-quotas` (configurable via `route`/`method`, method ∈ GET|POST, POST sends `{}`).
- All HTTP requests (login + quota) send header `User-Agent: pi-sub2api-usage/0.1.0`.
- sub2api envelope: HTTP 2xx + `code === 0` → success; anything else → error. 401 on quota call → drop cached token, re-login once, retry once.
- Repo layout: extension sources at repo root (repo is dedicated to this extension). Settings file `~/.pi/agent/pi-sub2api-usage.json`; token cache `~/.pi/agent/pi-sub2api-usage-cache.json` (mode 0600).
- models.json read path: `<agentDir>/models.json`; unreadable/invalid JSON → treated as "no marked providers" (silent), settings file unreadable/invalid → same defaults + one `warning` notify at session_start.
- Platform derivation: provider `api === "anthropic-messages"` → `anthropic`; `api` starts with `"openai"` → `openai`; else `platformMap[providerId]` if present; `platformMap` always wins when present. Undeterminable platform + no platformMap entry → chip `error: no platform`.
- `baseUrl` resolution: settings `baseUrl` wins; else derive from provider `baseUrl` by stripping a trailing `/v1` or `/v1/` segment (`http://h:8080/v1` → `http://h:8080`). Neither present → chip `error: no baseUrl`.

## Review Focus

1. **Provider switched mid-flight** (stale publish overwrites the new provider's chip) → generation-guard test in Task 5.
2. **Broken/absent models.json or settings JSON crashes startup** → malformed-input tests in Task 1 (must return defaults, never throw).
3. **Quota response lacks a record for the provider's platform** → `no quota` chip, not a crash (Task 4/5).
4. **Login response with missing `expires_in`** → token treated as immediately expired; re-login retry happens once, then `error:` chip (no infinite loop) (Task 3).
5. **Timers outliving the session** → session_shutdown clears all timers and controllers; all timers `.unref?.()` (Task 5).

---

### Task 1: Package scaffold + settings/models resolution

**Files:**
- Create: `package.json`, `tsconfig.json`, `src/settings.ts`
- Test: `test/settings.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces (used by Tasks 2–5):
  - `export interface Sub2ApiSettings { baseUrl?: string; email?: string; password?: string; token?: string; route: string; method: "GET" | "POST"; platformMap: Record<string, string>; refreshMs: number }`
  - `export interface ResolvedTarget { providerId: string; platform: string; instanceBaseUrl: string }`
  - `export function normalizeSettings(raw: unknown): Sub2ApiSettings`
  - `export function loadSettings(agentDir: string): { settings: Sub2ApiSettings; broken: boolean }`
  - `export function loadModelsProviders(agentDir: string): Record<string, { api?: unknown; baseUrl?: unknown; sub2api?: unknown }>`
  - `export function resolveProviderTarget(providerId: string | undefined, providers: Record<string, { api?: unknown; baseUrl?: unknown; sub2api?: unknown }>, settings: Sub2ApiSettings): ResolvedTarget | "unmarked" | "no-platform" | "no-base-url"`

- [ ] **Step 1: Write failing tests in `test/settings.test.ts`**

Cover, using `assert` from `node:assert/strict` and `node:test`:
- `normalizeSettings({})` → all defaults: `route === "/api/v1/user/platform-quotas"`, `method === "GET"`, `platformMap` deep-equals `{}`, `refreshMs === 300000`, other fields `undefined`.
- `normalizeSettings({ route: "/x", method: "POST", refreshMs: 1000, platformMap: { a: "b" }, baseUrl: "http://h", email: "e", password: "p", token: "t" })` round-trips those values.
- `normalizeSettings` with `method: "PUT"` / non-number `refreshMs` / negative `refreshMs` → falls back to defaults per-field; with non-object raw (`null`, `"x"`) → all defaults.
- `loadSettings` with a temp dir containing valid JSON → parsed + `broken === false`; with missing file → defaults + `broken === false`; with invalid JSON → defaults + `broken === true`. (Use `node:fs` + `node:os` tmpdir; `agentDir` is a parameter, not hardcoded.)
- `loadModelsProviders`: valid models.json `{"providers": {"p1": {"api": "anthropic-messages", "sub2api": true}}}` → table with `p1`; missing file / invalid JSON / `providers` not an object → `{}`.
- `resolveProviderTarget("p1", providers, settings)` with `sub2api: true` + `api: "anthropic-messages"` + provider `baseUrl: "http://h:8080"` → `{ providerId: "p1", platform: "anthropic", instanceBaseUrl: "http://h:8080" }`.
- Same with `api: "openai-responses"` → `platform: "openai"`; `baseUrl: "http://h:8080/v1"` → `instanceBaseUrl: "http://h:8080"`.
- `platformMap: { p1: "gemini" }` in settings overrides derivation → `platform: "gemini"`.
- Provider without `sub2api: true` (false/absent/other truthy type) → `"unmarked"`.
- Marked but `api: "google-gemini"`-like (no derivation) and no platformMap entry → `"no-platform"`.
- Marked, no settings.baseUrl, no provider.baseUrl → `"no-base-url"`.
- `providerId` undefined → `"unmarked"`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-strip-types --test test/settings.test.ts`
Expected: FAIL (cannot find module `../src/settings.ts`)

- [ ] **Step 3: Create `package.json`, `tsconfig.json`, implement `src/settings.ts`**

`package.json`: `name: "pi-sub2api-usage"`, `version: "0.1.0"`, `type: "module"`, `private: true`, `keywords: ["pi-package"]`, `"pi": { "extensions": ["./src/index.ts"] }`, `peerDependencies: { "@earendil-works/pi-coding-agent": "*" }`, `devDependencies: { "@earendil-works/pi-coding-agent": "1.1.0", "typescript": "^5.9.0", "@types/node": "^22.0.0" }`, scripts: `test: "node --experimental-strip-types --test test/*.test.ts"`, `typecheck: "tsc --noEmit"`.
`tsconfig.json`: `strict: true`, `module: "nodenext"`, `moduleResolution: "nodenext"`, `target: "es2023"`, `noEmit: true`, `include: ["src", "test"]`, `types: ["node"]`.
`src/settings.ts`: pure per-field normalization (guard each field's type); file reads via `node:fs` `readFileSync` + `JSON.parse` wrapped in try/catch; `/v1` strip via regex `/\/v1\/?$/`. No `agentDir` default inside the module (injected), so tests use temp dirs.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all settings tests PASS

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json src/settings.ts test/settings.test.ts package-lock.json 2>/dev/null || git add package.json tsconfig.json src/settings.ts test/settings.test.ts
git commit -m "feat: settings and models.json marker resolution"
```

---

### Task 2: sub2api quota client

**Files:**
- Create: `src/sub2api.ts`
- Test: `test/sub2api.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 (client takes resolved values).
- Produces (used by Tasks 4–5):
  - `export interface QuotaWindow { usageUsd: number; limitUsd: number | null; resetsAt: number | null }` (`resetsAt` = epoch ms)
  - `export interface PlatformQuota { platform: string; daily: QuotaWindow; weekly: QuotaWindow; monthly: QuotaWindow }`
  - `export function parsePlatformQuotas(payload: unknown): PlatformQuota[]` (throws `Error` with concise message on envelope `code !== 0`, missing `data.platform_quotas`, or non-array)
  - `export async function fetchQuotas(opts: { instanceBaseUrl: string; route: string; method: "GET" | "POST"; token: string; signal?: AbortSignal; timeoutMs?: number; fetchImpl?: typeof fetch }): Promise<PlatformQuota[]>` (default `timeoutMs: 15000`; non-2xx → throw with status; sets `Authorization: Bearer`, `User-Agent: pi-sub2api-usage/0.1.0`, `Accept: application/json`; POST body `{}`)
  - `export function findQuota(quotas: readonly PlatformQuota[], platform: string): PlatformQuota | undefined`

- [ ] **Step 1: Write failing tests in `test/sub2api.test.ts`**

- `parsePlatformQuotas` happy path with the spec's exact field names (`platform_quotas: [{ platform: "openai", daily_usage_usd: 6.2, daily_limit_usd: 10, daily_window_resets_at: "2026-10-11T00:00:00+08:00", weekly_usage_usd: 31, weekly_limit_usd: 100, weekly_window_resets_at: null, monthly_usage_usd: 12, monthly_limit_usd: null, monthly_window_resets_at: null }]`) → one PlatformQuota; `daily.usageUsd === 6.2`, `daily.resetsAt === Date.parse("2026-10-11T00:00:00+08:00")`, `weekly.resetsAt === null`, `monthly.limitUsd === null`.
- Extra unknown fields in records are ignored; records missing optional-null fields treated as null.
- `code: 1` envelope, missing `data`, `platform_quotas` not array, each of usage/limit/resets wrong-typed → throws.
- `fetchQuotas` with injected `fetchImpl` stub: asserts URL `${base}/api/v1/user/platform-quotas` (route), method GET, headers include Bearer token and fixed UA; returns parsed quotas. POST variant sends `{}` body.
- `fetchImpl` returning `{ status: 401 }` → throws Error whose message contains `401`.
- `fetchImpl` that never settles + tiny `timeoutMs` → rejects (AbortError path via AbortSignal.timeout or controller).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: sub2api tests FAIL (module missing)

- [ ] **Step 3: Implement `src/sub2api.ts`**

`fetchImpl` defaults to global `fetch`; timeout via `AbortController` + `setTimeout(...).unref()` combined with caller's signal via `AbortSignal.any`. Field validation helpers return `number | null` per spec semantics (usage must be number; limit/reset may be null).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add src/sub2api.ts test/sub2api.test.ts
git commit -m "feat: sub2api platform-quota client"
```

---

### Task 3: Panel auth (login + token cache)

**Files:**
- Create: `src/auth.ts`
- Test: `test/auth.test.ts`

**Interfaces:**
- Consumes: `Sub2ApiSettings` from Task 1.
- Produces (used by Task 5):
  - `export interface TokenState { accessToken: string; expiresAt: number }` (epoch ms)
  - `export class AuthError extends Error { constructor(message: string, readonly kind: "no-credentials" | "2fa" | "login-failed" | "captcha") }`
  - `export function readTokenCache(cachePath: string): TokenState | undefined` (missing/invalid → undefined)
  - `export function writeTokenCache(cachePath: string, state: TokenState): void` (writes JSON, then `chmodSync(path, 0o600)`; best-effort chmod)
  - `export async function obtainAccessToken(opts: { settings: Sub2ApiSettings; cachePath: string; now?: number; fetchImpl?: typeof fetch; signal?: AbortSignal }): Promise<TokenState>` — precedence: manual `settings.token` → `{ accessToken: token, expiresAt: Infinity }`; else valid cache (remaining > 60s) → cache; else login.
  - `export async function login(opts: { instanceBaseUrl: string; email: string; password: string; fetchImpl?: typeof fetch; signal?: AbortSignal; timeoutMs?: number }): Promise<TokenState>` — `POST {instanceBaseUrl}/api/v1/auth/login`, body `{ email, password }`, fixed UA; response `data.requires_2fa === true` → `AuthError("account has 2FA enabled", "2fa")`; `data.access_token` + `data.expires_in` (seconds) → TokenState (`expiresAt = now + expires_in*1000`); `expires_in` missing/non-number → `expiresAt = now` (immediately stale); envelope `code !== 0` with message matching /captcha|turnstile/i → `AuthError(..., "captcha")`; other failures → `AuthError(message, "login-failed")`.

- [ ] **Step 1: Write failing tests in `test/auth.test.ts`**

- Manual token precedence: settings with `token: "t"` → returns `{ accessToken: "t", expiresAt: Infinity }`, fetchImpl never called.
- Cache hit: temp-dir cache file with `expiresAt` > now+61s → returned without login; `expiresAt` within margin (now+30s) → login path taken.
- Login happy path: fetchImpl stub asserting URL/method/body/UA/JSON headers, resolving `{ ok: true, json: ... data: { access_token: "abc", expires_in: 3600 } }` → `{ accessToken: "abc", expiresAt: now + 3_600_000 }`; cache file written and mode is 0600 (skip mode assert on platforms lacking chmod — Linux fine).
- `requires_2fa: true` → AuthError kind `"2fa"`.
- `expires_in` absent → `expiresAt === now` (use injected `now`).
- Envelope `code: 1, message: "captcha required"` → kind `"captcha"`; `code: 1, message: "invalid credentials"` → kind `"login-failed"`; HTTP 401/403 → `"login-failed"`.
- Missing email+password+token → AuthError kind `"no-credentials"` (thrown by obtainAccessToken before any fetch).
- `readTokenCache` on garbage JSON → undefined.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: auth tests FAIL

- [ ] **Step 3: Implement `src/auth.ts`**

Straightforward composition of the tested precedence order; reuse the same timeout/UA conventions as Task 2 (extract a tiny shared `http.ts` helper only if duplication exceeds ~15 lines, else inline).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add src/auth.ts test/auth.test.ts
git commit -m "feat: panel login and access-token cache"
```

---

### Task 4: Chip formatting

**Files:**
- Create: `src/format.ts`
- Test: `test/format.test.ts`

**Interfaces:**
- Consumes: `PlatformQuota`, `QuotaWindow` from Task 2.
- Produces (used by Task 5):
  - `export function formatQuotaChip(providerId: string, quota: PlatformQuota, now: number): string`
  - `export function formatCountdown(resetsAt: number, now: number): string` (`"3d13h"`, `"2h12m"`, `"45m"`, `"12s"`)
  - `export function truncateChip(text: string, max?: number): string` (default 80, appends `…` when cut)

- [ ] **Step 1: Write failing tests in `test/format.test.ts`**

- Full spec case: quota with daily `{6.2/10, reset in 4h12m}`, weekly `{31/100}`, monthly `{12/100}` and `now` fixed → `formatQuotaChip("sub2api-gpt", q, now) === "📊 sub2api-gpt 62% ↻ 4h12m · wk 31% · mo 12%"`.
- Percent = `Math.floor(usage/limit*100)`.
- Null limit: daily `{usage 6.2, limit null}` → segment `$6.2` (`wk $31` style for weekly).
- Null `resetsAt` on daily → `↻` segment omitted entirely: `"📊 sub2api-gpt 62% · wk 31% · mo 12%"`.
- Countdown units: 3d13h, 2h12m, 45m, 12s; `resetsAt <= now` → `"0s"`.
- Truncation: 90-char input → 80 chars + `…` (81 total); under limit unchanged.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: format tests FAIL

- [ ] **Step 3: Implement `src/format.ts`**

Usd formatting: `\$${usage.toFixed(usage < 10 ? 1 : 0)}` (matches `$6.2`/`$31` examples). Join windows with `" · "`, weekly/monthy prefixed `wk `/`mo `.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add src/format.ts test/format.test.ts
git commit -m "feat: statusline chip formatting"
```

---

### Task 5: Extension runtime (refresh pipeline, events, command)

**Files:**
- Create: `src/statusline.ts`, `src/index.ts`
- Test: `test/runtime.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–4 (exact signatures above).
- Produces: `src/index.ts` default export `sub2apiUsageExtension(pi: ExtensionAPI): void`; `src/statusline.ts` exports testable internals `createRuntime(deps: RuntimeDeps): Runtime` where
  - `interface RuntimeDeps { agentDir: string; fetchImpl?: typeof fetch; now?: () => number; setTimeoutImpl?: typeof setTimeout }`
  - `interface Runtime { handleEvent(ctx: ExtensionContext, model: { provider?: string } | undefined): void; shutdown(ctx: ExtensionContext): void; runManualCheck(ctx: ExtensionCommandContext): Promise<void> }`

- [ ] **Step 1: Write failing tests in `test/runtime.test.ts`**

Build a fake `pi` (records `on`/`registerCommand` calls) and fake `ctx` (`ui.setStatus` spy map, `ui.notify` spy). Use temp agentDir with models.json (`sub2api-gpt` marked, `api: "openai-responses"`, baseUrl with `/v1`) + settings (email/password) + scripted fetchImpl (login → quotas).
- `model_select` to marked provider → `setStatus("sub2api-usage", ...)` eventually equals `checking` then a string starting `"📊 sub2api-gpt "` containing `%`; status key `usage` never written.
- Second event within TTL (advance fake clock < 300000) → fetchImpl login/quota calls NOT repeated (cache), but setStatus re-published.
- Switch to unmarked provider → status cleared (`undefined`).
- 401-on-quota script (first quota call 401, then login + quota OK) → final chip published, exactly 2 quota calls + 2 logins... precisely: token invalidated → 1 extra login; assert no infinite retry (cap 2 quota attempts).
- Login rejected (`code:1 invalid credentials`) → chip matches `/sub2api-usage/` value `"📊 sub2api-gpt error: login-failed"`... exact: starts with `"📊 sub2api-gpt error:"`.
- Quotas response lacking the platform → `"📊 sub2api-gpt no quota"`.
- Stale publish guard: start refresh for provider A, switch generation (second event, provider B) before fetch resolves → A's late result discarded (final status reflects B or cleared).
- Failure backoff: quota fetch throws → `error:` chip; immediate second event within 30s (fake clock) → no new fetch attempt.
- `shutdown` → all timers cleared: fire pending timer callbacks and assert no setStatus afterwards; repeated shutdown is safe.
- Timer re-render: published chip contains `↻`; advance fake clock 60s and fire timers → setStatus called again with recomputed countdown, no fetch.
- `registerCommand("sub2api-usage", ...)` called once; its handler performs a forced (cache-busting) query and `notify`s with JSON containing `"platform_quotas"`.
- Broken settings JSON in temp agentDir (provider marked) → session_start event produces exactly one `warning` notify and final chip `📊 sub2api-gpt error: no credentials` (defaults + no credentials path).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: runtime tests FAIL

- [ ] **Step 3: Implement `src/statusline.ts` and `src/index.ts`**

`statusline.ts` holds `createRuntime`: closure with generation counter, quota cache (`Map` keyed `providerId:platform` with `{ quotas, fetchedAt }`), failure backoff map, in-flight single-flight per refresh, countdown timer, status controller. Query pipeline: `resolveProviderTarget` → auth (`obtainAccessToken`) → cache-or-`fetchQuotas` → `findQuota` → `formatQuotaChip`; each failure maps to the spec's chip strings; broken-settings warning notify fires once per session when `loadSettings().broken`. `index.ts` wires `pi.on(...)` for `session_start`/`session_tree`/`model_select`/`turn_start`/`session_shutdown` to `runtime.handleEvent(ctx, ctx.model)` and registers the command. Wrap `ctx.ui.setStatus` in try/catch that swallows stale-context errors (message match `/stale|disposed/i`) as pi-usage does.

- [ ] **Step 4: Run tests to verify they pass + typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: all PASS, no type errors

- [ ] **Step 5: Commit**

```bash
git add src/statusline.ts src/index.ts test/runtime.test.ts
git commit -m "feat: extension runtime with refresh pipeline and command"
```

---

### Task 6: Real-instance verification + install + README

**Files:**
- Create: `README.md`
- Modify: possibly `~/.pi/agent/models.json` (add `"sub2api": true` to the two providers) and create `~/.pi/agent/pi-sub2api-usage.json` (with real credentials) — user-owned files outside the repo

**Interfaces:**
- Consumes: complete extension from Tasks 1–5.
- Produces: installed, verified extension.

- [ ] **Step 1: Preflight curl checks against the real instance (needs user's panel credentials in a shell-local variable, never committed)**

```bash
# login → extract access_token
TOKEN=$(curl -fsS -X POST http://43.159.131.239:8080/api/v1/auth/login \
  -H 'Content-Type: application/json' -H 'User-Agent: pi-sub2api-usage/0.1.0' \
  -d "{\"email\":\"$S2A_EMAIL\",\"password\":\"$S2A_PASS\"}" | python3 -c 'import json,sys;print(json.load(sys.stdin)["data"]["access_token"])')
# quota probe
curl -fsS http://43.159.131.239:8080/api/v1/user/platform-quotas \
  -H "Authorization: Bearer $TOKEN" -H 'User-Agent: pi-sub2api-usage/0.1.0'
```
Expected: JSON with `code: 0` and a `platform_quotas` array containing `openai` and `anthropic` records. Any 4xx → stop and reconcile with the design's preconditions (captcha / 2FA / backend mode) before proceeding; do NOT code around it silently.

- [ ] **Step 2: Configure the two user-owned files**

Add `"sub2api": true` to `sub2api-gpt` and `sub2api-claude` in `~/.pi/agent/models.json`; create `~/.pi/agent/pi-sub2api-usage.json` with real `email`/`password`/`baseUrl` (`"http://43.159.131.239:8080"`), then `chmod 600` it.

- [ ] **Step 3: Install and smoke-test in a real pi session**

```bash
pi install . && pi list
```
Then run `pi`, switch model to `sub2api-gpt/gpt-6-luna` and confirm the chip `📊 sub2api-gpt …% ↻ … · wk …% · mo …%` renders in the statusline; switch to a zai model and confirm the chip disappears while pi-usage's `📊 zai …` still works; run `/sub2api-usage`.

- [ ] **Step 4: Write `README.md`**

Sections: what it does (one paragraph), statusline preview line, models.json marker, settings file reference (all fields incl. manual `token` fallback and `chmod 600` note), preconditions (no captcha / no 2FA / backend-mode note), `/sub2api-usage` command, uninstall.

- [ ] **Step 5: Final full verification and commit**

Run: `npm test && npx tsc --noEmit`
Expected: all PASS. Commit README (config files with credentials are outside the repo and must never be added):

```bash
git add README.md
git commit -m "docs: README with configuration reference"
```
