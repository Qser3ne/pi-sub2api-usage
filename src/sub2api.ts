export const SUB2API_USER_AGENT = "pi-sub2api-usage/0.1.0";
const DEFAULT_TIMEOUT_MS = 15_000;

/** A usage window (e.g. five_hour / seven_day) from the admin account-usage endpoint. */
export interface UsageWindow {
  /** Percent used, 0–100+. */
  utilization: number | null;
  /** Epoch milliseconds; null when no reset is scheduled. */
  resetsAt: number | null;
}

export interface AccountUsage {
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const parseWindow = (value: unknown, label: string): UsageWindow | null => {
  if (value === null || value === undefined) return null;
  const record = asRecord(value);
  if (record === undefined) {
    throw new Error(`invalid ${label}: expected object or null`);
  }
  const utilization = record.utilization;
  if (typeof utilization !== "number" || !Number.isFinite(utilization)) {
    throw new Error(`invalid ${label}.utilization`);
  }
  const resetsAtRaw = record.resets_at;
  let resetsAt: number | null = null;
  if (resetsAtRaw !== null && resetsAtRaw !== undefined) {
    if (typeof resetsAtRaw !== "string") throw new Error(`invalid ${label}.resets_at`);
    const parsed = Date.parse(resetsAtRaw);
    if (!Number.isFinite(parsed)) throw new Error(`unparseable ${label}.resets_at`);
    resetsAt = parsed;
  }
  return { utilization, resetsAt };
};

export function parseAccountUsage(payload: unknown): AccountUsage {
  const envelope = asRecord(payload);
  if (!envelope || envelope.code !== 0) {
    throw new Error(`sub2api envelope error: ${JSON.stringify(envelope?.message ?? "missing envelope")}`);
  }
  const data = asRecord(envelope.data);
  if (data === undefined) {
    throw new Error("sub2api response missing data");
  }
  return {
    fiveHour: parseWindow(data.five_hour, "five_hour"),
    sevenDay: parseWindow(data.seven_day, "seven_day"),
  };
}

export interface FetchAccountUsageOptions {
  instanceBaseUrl: string;
  /** Route template with `{id}` placeholder. */
  route: string;
  method: "GET" | "POST";
  token: string;
  accountId: number;
  usageSource: "passive" | "active";
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export async function fetchAccountUsage(options: FetchAccountUsageOptions): Promise<AccountUsage> {
  const { instanceBaseUrl, route, method, token, accountId, usageSource } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const path = route.replace("{id}", encodeURIComponent(String(accountId)));
  const base = `${instanceBaseUrl.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
  const url = route.includes("source=") ? base : `${base}?source=${usageSource}`;
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
  return parseAccountUsage(await response.json());
}
