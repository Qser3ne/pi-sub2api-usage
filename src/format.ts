import type { PlatformQuota, QuotaWindow } from "./sub2api.ts";

const CHIP_PREFIX = "📊";
const MAX_CHIP_LENGTH = 80;

const formatUsd = (usage: number): string =>
  `$${usage.toFixed(usage < 10 ? 1 : 0)}`;

const formatUsage = (window: QuotaWindow): string => {
  if (window.limitUsd === null || window.limitUsd <= 0) return formatUsd(window.usageUsd);
  return `${Math.floor((window.usageUsd / window.limitUsd) * 100)}%`;
};

export function formatCountdown(resetsAt: number, now: number): string {
  const remainingMs = resetsAt - now;
  if (remainingMs <= 0) return "0s";
  const totalSeconds = Math.floor(remainingMs / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (days >= 1) return `${days}d${hours}h`;
  if (hours >= 1) return `${hours}h${minutes}m`;
  if (minutes >= 1) return `${minutes}m`;
  return `${seconds}s`;
}

export function truncateChip(text: string, max = MAX_CHIP_LENGTH): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

export function formatQuotaChip(providerId: string, quota: PlatformQuota, now: number): string {
  const daily = formatUsage(quota.daily);
  const countdown =
    quota.daily.resetsAt !== null && quota.daily.resetsAt > now
      ? ` ↻ ${formatCountdown(quota.daily.resetsAt, now)}`
      : "";
  const segments = [
    `${daily}${countdown}`,
    `wk ${formatUsage(quota.weekly)}`,
    `mo ${formatUsage(quota.monthly)}`,
  ];
  return truncateChip(`${CHIP_PREFIX} ${providerId} ${segments.join(" · ")}`);
}
