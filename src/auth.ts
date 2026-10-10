import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { SUB2API_USER_AGENT } from "./sub2api.ts";
import type { Sub2ApiSettings } from "./settings.ts";

export interface TokenState {
  accessToken: string;
  /** Epoch milliseconds; Infinity for manual tokens. */
  expiresAt: number;
}

export type AuthErrorKind = "no-credentials" | "2fa" | "login-failed" | "captcha";

export class AuthError extends Error {
  readonly kind: AuthErrorKind;

  constructor(message: string, kind: AuthErrorKind) {
    super(message);
    this.name = "AuthError";
    this.kind = kind;
  }
}

const TOKEN_MARGIN_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const LOGIN_ROUTE = "/api/v1/auth/login";

export function readTokenCache(cachePath: string): TokenState | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(cachePath, "utf8"));
  } catch {
    return undefined;
  }
  if (raw === null || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record.accessToken !== "string" || record.accessToken.length === 0) return undefined;
  if (typeof record.expiresAt !== "number" || !Number.isFinite(record.expiresAt)) return undefined;
  return { accessToken: record.accessToken, expiresAt: record.expiresAt };
}

export function writeTokenCache(cachePath: string, state: TokenState): void {
  writeFileSync(cachePath, `${JSON.stringify(state)}\n`, "utf8");
  try {
    chmodSync(cachePath, 0o600);
  } catch {
    // Best-effort: platforms without chmod still get the cache, just without the mode.
  }
}

export interface LoginOptions {
  instanceBaseUrl: string;
  email: string;
  password: string;
  now?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function login(options: LoginOptions): Promise<TokenState> {
  const now = options.now ?? Date.now();
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  timer.unref?.();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const url = `${options.instanceBaseUrl.replace(/\/+$/, "")}${LOGIN_ROUTE}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": SUB2API_USER_AGENT,
        Accept: "application/json",
      },
      body: JSON.stringify({ email: options.email, password: options.password }),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new AuthError(`login request failed: ${String(error)}`, "login-failed");
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new AuthError(`login responded ${response.status}`, "login-failed");
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new AuthError(`login response was not JSON: ${String(error)}`, "login-failed");
  }
  const envelope = (payload !== null && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  if (envelope.code !== 0) {
    const message = typeof envelope.message === "string" ? envelope.message : "login failed";
    if (/captcha|turnstile/i.test(message)) {
      throw new AuthError(`instance requires a login captcha: ${message}`, "captcha");
    }
    throw new AuthError(message, "login-failed");
  }
  const data = (envelope.data !== null && typeof envelope.data === "object" ? envelope.data : {}) as Record<
    string,
    unknown
  >;
  if (data.requires_2fa === true) {
    throw new AuthError("account has 2FA enabled; auto-login is not supported", "2fa");
  }
  if (typeof data.access_token !== "string" || data.access_token.length === 0) {
    throw new AuthError("login response missing access_token", "login-failed");
  }
  const expiresIn = data.expires_in;
  const expiresAt =
    typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
      ? now + expiresIn * 1_000
      : now;
  return { accessToken: data.access_token, expiresAt };
}

export interface ObtainAccessTokenOptions {
  settings: Sub2ApiSettings;
  cachePath: string;
  /** Resolved instance base URL; defaults to settings.baseUrl. */
  instanceBaseUrl?: string;
  now?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export async function obtainAccessToken(options: ObtainAccessTokenOptions): Promise<TokenState> {
  const { settings } = options;
  if (settings.token !== undefined) {
    return { accessToken: settings.token, expiresAt: Number.POSITIVE_INFINITY };
  }
  const now = options.now ?? Date.now();
  const cached = readTokenCache(options.cachePath);
  if (cached !== undefined && cached.expiresAt - now > TOKEN_MARGIN_MS) {
    return cached;
  }
  if (settings.email === undefined || settings.password === undefined) {
    throw new AuthError("no credentials: set token or email+password in pi-sub2api-usage.json", "no-credentials");
  }
  const instanceBaseUrl = options.instanceBaseUrl ?? settings.baseUrl;
  if (instanceBaseUrl === undefined) {
    throw new AuthError("no baseUrl: set baseUrl in pi-sub2api-usage.json or provider baseUrl in models.json", "login-failed");
  }
  const state = await login({
    instanceBaseUrl,
    email: settings.email,
    password: settings.password,
    now,
    fetchImpl: options.fetchImpl,
    signal: options.signal,
  });
  writeTokenCache(options.cachePath, state);
  return state;
}
