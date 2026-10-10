export interface QuotaWindow {
  usageUsd: number;
  limitUsd: number | null;
  /** Epoch milliseconds; null when the window has no reset scheduled. */
  resetsAt: number | null;
}

export interface PlatformQuota {
  platform: string;
  daily: QuotaWindow;
  weekly: QuotaWindow;
  monthly: QuotaWindow;
}

export const SUB2API_USER_AGENT = "pi-sub2api-usage/0.1.0";
const DEFAULT_TIMEOUT_MS = 15_000;
const WINDOW_PREFIXES = ["daily", "weekly", "monthly"] as const;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const usageOf = (record: Record<string, unknown>, prefix: string): number => {
  const value = record[`${prefix}_usage_usd`];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`invalid ${prefix}_usage_usd for platform ${String(record.platform)}`);
  }
  return value;
};

const limitOf = (record: Record<string, unknown>, prefix: string): number | null => {
  const value = record[`${prefix}_limit_usd`];
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`invalid ${prefix}_limit_usd for platform ${String(record.platform)}`);
  }
  return value;
};

const resetsAtOf = (record: Record<string, unknown>, prefix: string): number | null => {
  const value = record[`${prefix}_window_resets_at`];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new Error(`invalid ${prefix}_window_resets_at for platform ${String(record.platform)}`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`unparseable ${prefix}_window_resets_at for platform ${String(record.platform)}`);
  }
  return parsed;
};

const windowOf = (record: Record<string, unknown>, prefix: string): QuotaWindow => ({
  usageUsd: usageOf(record, prefix),
  limitUsd: limitOf(record, prefix),
  resetsAt: resetsAtOf(record, prefix),
});

export function parsePlatformQuotas(payload: unknown): PlatformQuota[] {
  const envelope = asRecord(payload);
  if (!envelope || envelope.code !== 0) {
    throw new Error(`sub2api envelope error: ${JSON.stringify(envelope?.message ?? "missing envelope")}`);
  }
  const data = asRecord(envelope.data);
  const rawQuotas = data?.platform_quotas;
  if (!Array.isArray(rawQuotas)) {
    throw new Error("sub2api response missing data.platform_quotas array");
  }
  return rawQuotas.map((entry) => {
    const record = asRecord(entry);
    const platform = record?.platform;
    if (!record || typeof platform !== "string" || platform.trim().length === 0) {
      throw new Error("platform_quotas entry missing platform string");
    }
    return {
      platform,
      daily: windowOf(record, "daily"),
      weekly: windowOf(record, "weekly"),
      monthly: windowOf(record, "monthly"),
    };
  });
}

export interface FetchQuotasOptions {
  instanceBaseUrl: string;
  route: string;
  method: "GET" | "POST";
  token: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export async function fetchQuotas(options: FetchQuotasOptions): Promise<PlatformQuota[]> {
  const { instanceBaseUrl, route, method, token } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const url = `${instanceBaseUrl.replace(/\/+$/, "")}${route.startsWith("/") ? route : `/${route}`}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method,
      signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": SUB2API_USER_AGENT,
        Accept: "application/json",
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
      },
      ...(method === "POST" ? { body: "{}" } : {}),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error(`sub2api request failed: ${String(error)}`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(`sub2api responded ${response.status}`);
  }
  return parsePlatformQuotas(await response.json());
}

export function findQuota(quotas: readonly PlatformQuota[], platform: string): PlatformQuota | undefined {
  return quotas.find((quota) => quota.platform === platform);
}
