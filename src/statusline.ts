import { rmSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AuthError, obtainAccessToken, type TokenState } from "./auth.ts";
import { formatQuotaChip } from "./format.ts";
import {
  loadModelsProviders,
  loadSettings,
  resolveProviderTarget,
  type ResolvedTarget,
  type Sub2ApiSettings,
} from "./settings.ts";
import { fetchQuotas, findQuota, type PlatformQuota } from "./sub2api.ts";

const STATUS_KEY = "sub2api-usage";
const CHIP_PREFIX = "📊";
const FAILURE_BACKOFF_MS = 30_000;
const COUNTDOWN_REFRESH_MS = 60_000;
const ERROR_TEXT_LIMIT = 40;
const CACHE_FILE_NAME = "pi-sub2api-usage-cache.json";

export interface RuntimeDeps {
  agentDir: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
}

export interface Runtime {
  handleEvent(ctx: ExtensionContext, model: { provider?: string } | undefined): void;
  shutdown(ctx: ExtensionContext): void;
  runManualCheck(ctx: ExtensionCommandContext): Promise<void>;
}

interface QuotaCacheEntry {
  quotas: PlatformQuota[];
  fetchedAt: number;
}

interface FailureEntry {
  until: number;
  message: string;
}

const isStaleContextError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return /stale|disposed/i.test(message);
};

const errorChipText = (error: unknown): string => {
  if (error instanceof AuthError) {
    switch (error.kind) {
      case "no-credentials":
        return "error: no credentials";
      case "2fa":
        return "error: 2FA not supported";
      case "captcha":
        return "error: captcha required";
      default:
        return "error: login failed";
    }
  }
  const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
  return `error: ${message.slice(0, ERROR_TEXT_LIMIT)}`;
};

const isUnauthorizedError = (error: unknown): boolean =>
  /\b401\b/.test(error instanceof Error ? error.message : String(error));

export function createRuntime(deps: RuntimeDeps): Runtime {
  const { agentDir } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const setTimeoutImpl = deps.setTimeoutImpl ?? setTimeout;
  const clearTimeoutImpl = deps.clearTimeoutImpl ?? clearTimeout;
  const cachePath = join(agentDir, CACHE_FILE_NAME);

  let generation = 0;
  let statusController: AbortController | undefined;
  let countdownTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let settingsWarningSent = false;
  const quotaCache = new Map<string, QuotaCacheEntry>();
  const failures = new Map<string, FailureEntry>();

  const clearCountdownTimer = () => {
    if (countdownTimer !== undefined) clearTimeoutImpl(countdownTimer);
    countdownTimer = undefined;
  };

  const clearRefreshTimer = () => {
    if (refreshTimer !== undefined) clearTimeoutImpl(refreshTimer);
    refreshTimer = undefined;
  };

  const safeSetStatus = (ctx: ExtensionContext, value: string | undefined): boolean => {
    try {
      ctx.ui.setStatus(STATUS_KEY, value);
      return true;
    } catch (error) {
      if (isStaleContextError(error)) return false;
      throw error;
    }
  };

  const safeNotify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error") => {
    try {
      ctx.ui.notify(message, level);
    } catch (error) {
      if (!isStaleContextError(error)) throw error;
    }
  };

  const loadRuntimeConfig = (ctx: ExtensionContext): { settings: Sub2ApiSettings; broken: boolean } => {
    const loaded = loadSettings(agentDir);
    if (loaded.broken && !settingsWarningSent) {
      settingsWarningSent = true;
      safeNotify(
        ctx,
        "pi-sub2api-usage.json is invalid; using defaults. Fix the file to restore sub2api usage display.",
        "warning",
      );
    }
    return loaded;
  };

  const recordFailure = (cacheKey: string, message: string) => {
    failures.set(cacheKey, { until: now() + FAILURE_BACKOFF_MS, message });
  };

  const publishError = (ctx: ExtensionContext, target: ResolvedTarget, error: unknown) => {
    safeSetStatus(ctx, `${CHIP_PREFIX} ${target.providerId} ${errorChipText(error)}`);
  };

  const scheduleCountdownReRender = (
    ctx: ExtensionContext,
    target: ResolvedTarget,
    quotas: PlatformQuota[],
    gen: number,
  ) => {
    clearCountdownTimer();
    countdownTimer = setTimeoutImpl(() => {
      countdownTimer = undefined;
      if (gen !== generation) return;
      const quota = findQuota(quotas, target.platform);
      if (quota !== undefined) {
        safeSetStatus(ctx, formatQuotaChip(target.providerId, quota, now()));
      }
      scheduleCountdownReRender(ctx, target, quotas, gen);
    }, COUNTDOWN_REFRESH_MS);
    countdownTimer?.unref?.();
  };

  const scheduleRefresh = (
    ctx: ExtensionContext,
    settings: Sub2ApiSettings,
    gen: number,
    delayMs: number,
  ) => {
    clearRefreshTimer();
    refreshTimer = setTimeoutImpl(() => {
      refreshTimer = undefined;
      if (gen !== generation) return;
      handleEvent(ctx, ctx.model);
    }, Math.max(1, delayMs));
    refreshTimer?.unref?.();
  };

  const publishResult = (
    ctx: ExtensionContext,
    target: ResolvedTarget,
    settings: Sub2ApiSettings,
    quotas: PlatformQuota[],
    gen: number,
  ) => {
    const quota = findQuota(quotas, target.platform);
    if (quota === undefined) {
      safeSetStatus(ctx, `${CHIP_PREFIX} ${target.providerId} no quota`);
    } else {
      safeSetStatus(ctx, formatQuotaChip(target.providerId, quota, now()));
      if (quota.daily.resetsAt !== null && quota.daily.resetsAt > now()) {
        scheduleCountdownReRender(ctx, target, quotas, gen);
      }
    }
    scheduleRefresh(ctx, settings, gen, settings.refreshMs);
  };

  const acquireToken = async (
    ctx: ExtensionContext,
    target: ResolvedTarget,
    settings: Sub2ApiSettings,
    gen: number,
  ): Promise<TokenState | undefined> => {
    try {
      return await obtainAccessToken({
        settings,
        cachePath,
        instanceBaseUrl: target.instanceBaseUrl,
        now: now(),
        fetchImpl,
        signal: statusController?.signal,
      });
    } catch (error) {
      if (gen !== generation || isStaleContextError(error)) return undefined;
      publishError(ctx, target, error);
      recordFailure(`${target.providerId}:${target.platform}`, errorChipText(error));
      scheduleRefresh(ctx, settings, gen, FAILURE_BACKOFF_MS);
      return undefined;
    }
  };

  const fetchWithUnauthorizedRetry = async (
    target: ResolvedTarget,
    settings: Sub2ApiSettings,
    token: TokenState,
  ): Promise<PlatformQuota[]> => {
    try {
      return await fetchQuotas({
        instanceBaseUrl: target.instanceBaseUrl,
        route: settings.route,
        method: settings.method,
        token: token.accessToken,
        fetchImpl,
        signal: statusController?.signal,
      });
    } catch (error) {
      if (!isUnauthorizedError(error)) throw error;
      rmSync(cachePath, { force: true });
      throw error;
    }
  };

  const refresh = async (
    ctx: ExtensionContext,
    target: ResolvedTarget,
    settings: Sub2ApiSettings,
    gen: number,
    force: boolean,
  ) => {
    const cacheKey = `${target.providerId}:${target.platform}`;
    const nowMs = now();
    if (!force) {
      const cached = quotaCache.get(cacheKey);
      if (cached !== undefined && cached.fetchedAt + settings.refreshMs > nowMs) {
        publishResult(ctx, target, settings, cached.quotas, gen);
        scheduleRefresh(ctx, settings, gen, cached.fetchedAt + settings.refreshMs - nowMs);
        return;
      }
      const failure = failures.get(cacheKey);
      if (failure !== undefined && failure.until > nowMs) {
        safeSetStatus(ctx, `${CHIP_PREFIX} ${target.providerId} ${failure.message}`);
        scheduleRefresh(ctx, settings, gen, failure.until - nowMs);
        return;
      }
      failures.delete(cacheKey);
    }
    const token = await acquireToken(ctx, target, settings, gen);
    if (token === undefined || gen !== generation) return;
    let quotas: PlatformQuota[];
    try {
      quotas = await fetchWithUnauthorizedRetry(target, settings, token);
    } catch (error) {
      if (gen !== generation || isStaleContextError(error)) return;
      if (isUnauthorizedError(error)) {
        const reToken = await acquireToken(ctx, target, settings, gen);
        if (reToken === undefined || gen !== generation) return;
        try {
          quotas = await fetchWithUnauthorizedRetry(target, settings, reToken);
        } catch (retryError) {
          if (gen !== generation || isStaleContextError(retryError)) return;
          publishError(ctx, target, retryError);
          recordFailure(cacheKey, errorChipText(retryError));
          scheduleRefresh(ctx, settings, gen, FAILURE_BACKOFF_MS);
          return;
        }
      } else {
        publishError(ctx, target, error);
        recordFailure(cacheKey, errorChipText(error));
        scheduleRefresh(ctx, settings, gen, FAILURE_BACKOFF_MS);
        return;
      }
    }
    if (gen !== generation) return;
    quotaCache.set(cacheKey, { quotas, fetchedAt: now() });
    publishResult(ctx, target, settings, quotas, gen);
  };

  const handleEvent = (ctx: ExtensionContext, model: { provider?: string } | undefined): void => {
    generation += 1;
    const gen = generation;
    statusController?.abort();
    statusController = new AbortController();
    clearCountdownTimer();
    clearRefreshTimer();
    const { settings } = loadRuntimeConfig(ctx);
    const providers = loadModelsProviders(agentDir);
    const resolution = resolveProviderTarget(model?.provider, providers, settings);
    if (resolution === "unmarked" || resolution === "no-platform" || resolution === "no-base-url") {
      if (resolution === "no-platform") {
        safeSetStatus(ctx, `${CHIP_PREFIX} ${model?.provider ?? "unknown"} error: no platform`);
      } else if (resolution === "no-base-url") {
        safeSetStatus(ctx, `${CHIP_PREFIX} ${model?.provider ?? "unknown"} error: no baseUrl`);
      } else {
        safeSetStatus(ctx, undefined);
      }
      return;
    }
    safeSetStatus(ctx, `${CHIP_PREFIX} ${resolution.providerId} checking`);
    void refresh(ctx, resolution, settings, gen, false).catch((error) => {
      if (gen !== generation || isStaleContextError(error)) return;
      try {
        safeSetStatus(ctx, `${CHIP_PREFIX} ${resolution.providerId} ${errorChipText(error)}`);
      } catch {
        // Context went away entirely; nothing left to report to.
      }
    });
  };

  const shutdown = (ctx: ExtensionContext): void => {
    generation += 1;
    statusController?.abort();
    statusController = undefined;
    clearCountdownTimer();
    clearRefreshTimer();
    quotaCache.clear();
    failures.clear();
    safeSetStatus(ctx, undefined);
  };

  const runManualCheck = async (ctx: ExtensionCommandContext): Promise<void> => {
    generation += 1;
    const gen = generation;
    statusController?.abort();
    statusController = new AbortController();
    clearCountdownTimer();
    clearRefreshTimer();
    const { settings } = loadRuntimeConfig(ctx);
    const providers = loadModelsProviders(agentDir);
    const resolution = resolveProviderTarget(ctx.model?.provider, providers, settings);
    if (typeof resolution !== "object") {
      safeNotify(
        ctx,
        `Current provider is not marked "sub2api": true in models.json (${String(ctx.model?.provider ?? "none")}).`,
        "info",
      );
      return;
    }
    const token = await acquireToken(ctx, resolution, settings, gen);
    if (token === undefined) return;
    try {
      const quotas = await fetchWithUnauthorizedRetry(resolution, settings, token);
      if (gen !== generation) return;
      quotaCache.set(`${resolution.providerId}:${resolution.platform}`, { quotas, fetchedAt: now() });
      const quota = findQuota(quotas, resolution.platform);
      if (quota === undefined) {
        safeNotify(ctx, `No quota record for platform ${resolution.platform}.`, "warning");
      } else {
        const raw = JSON.stringify({ platform_quotas: [quota] }, null, 2);
        safeNotify(ctx, raw.length > 1_500 ? `${raw.slice(0, 1_500)}…` : raw, "info");
        safeSetStatus(ctx, formatQuotaChip(resolution.providerId, quota, now()));
      }
    } catch (error) {
      if (gen !== generation || isStaleContextError(error)) return;
      safeNotify(ctx, `sub2api check failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  };

  return { handleEvent, shutdown, runManualCheck };
}
