import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface Sub2ApiSettings {
  /** Instance root without a trailing /v1 segment. */
  baseUrl?: string;
  email?: string;
  password?: string;
  /** Manual access token; takes precedence over auto-login. */
  token?: string;
  route: string;
  method: "GET" | "POST";
  platformMap: Record<string, string>;
  refreshMs: number;
}

export interface ResolvedTarget {
  providerId: string;
  platform: string;
  instanceBaseUrl: string;
}

export type ProviderResolution = ResolvedTarget | "unmarked" | "no-platform" | "no-base-url";

export interface ModelsProviderEntry {
  api?: unknown;
  baseUrl?: unknown;
  sub2api?: unknown;
}

const DEFAULT_ROUTE = "/api/v1/user/platform-quotas";
const DEFAULT_REFRESH_MS = 300_000;

const stringOrUndefined = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

export function normalizeSettings(raw: unknown): Sub2ApiSettings {
  const source = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const method = source.method === "POST" ? "POST" : "GET";
  const refreshMsRaw = source.refreshMs;
  const refreshMs =
    typeof refreshMsRaw === "number" && Number.isFinite(refreshMsRaw) && refreshMsRaw > 0
      ? refreshMsRaw
      : DEFAULT_REFRESH_MS;
  const platformMapRaw = source.platformMap;
  const platformMap: Record<string, string> = {};
  if (platformMapRaw !== null && typeof platformMapRaw === "object") {
    for (const [key, value] of Object.entries(platformMapRaw as Record<string, unknown>)) {
      if (typeof value === "string" && value.trim().length > 0) platformMap[key] = value.trim();
    }
  }
  return {
    baseUrl: stringOrUndefined(source.baseUrl),
    email: stringOrUndefined(source.email),
    password: stringOrUndefined(source.password),
    token: stringOrUndefined(source.token),
    route: stringOrUndefined(source.route) ?? DEFAULT_ROUTE,
    method,
    platformMap,
    refreshMs,
  };
}

export function loadSettings(agentDir: string): { settings: Sub2ApiSettings; broken: boolean } {
  const loaded = loadJsonFile(join(agentDir, "pi-sub2api-usage.json"), normalizeSettings);
  return { settings: loaded.value, broken: loaded.broken };
}

export function loadModelsProviders(agentDir: string): Record<string, ModelsProviderEntry> {
  return loadJsonFile(
    join(agentDir, "models.json"),
    (raw): Record<string, ModelsProviderEntry> => {
      const source = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const providers = source.providers;
      if (providers === null || typeof providers !== "object" || Array.isArray(providers)) return {};
      const out: Record<string, ModelsProviderEntry> = {};
      for (const [id, entry] of Object.entries(providers as Record<string, unknown>)) {
        if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
          out[id] = entry as ModelsProviderEntry;
        }
      }
      return out;
    },
  ).value;
}

function loadJsonFile<T>(path: string, parse: (raw: unknown) => T): { value: T; broken: boolean } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    // Missing or unreadable file: not "broken" — the file is optional.
    return { value: parse(undefined), broken: false };
  }
  try {
    return { value: parse(JSON.parse(text)), broken: false };
  } catch {
    return { value: parse(undefined), broken: true };
  }
}

const derivePlatform = (api: unknown): string | undefined => {
  if (typeof api !== "string") return undefined;
  if (api === "anthropic-messages") return "anthropic";
  if (api.startsWith("openai")) return "openai";
  return undefined;
};

const instanceBaseUrlFromProvider = (providerBaseUrl: unknown): string | undefined =>
  typeof providerBaseUrl === "string" && providerBaseUrl.trim().length > 0
    ? providerBaseUrl.trim().replace(/\/v1\/?$/, "")
    : undefined;

export function resolveProviderTarget(
  providerId: string | undefined,
  providers: Record<string, ModelsProviderEntry>,
  settings: Sub2ApiSettings,
): ProviderResolution {
  if (providerId === undefined) return "unmarked";
  const entry = providers[providerId];
  if (!entry || entry.sub2api !== true) return "unmarked";
  const platform = settings.platformMap[providerId] ?? derivePlatform(entry.api);
  if (platform === undefined) return "no-platform";
  const instanceBaseUrl = settings.baseUrl ?? instanceBaseUrlFromProvider(entry.baseUrl);
  if (instanceBaseUrl === undefined) return "no-base-url";
  return { providerId, platform, instanceBaseUrl };
}
