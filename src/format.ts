import type { AccountUsage, UsageWindow } from "./sub2api.ts";

const CHIP_PREFIX = "📊";
const MAX_CHIP_LENGTH = 80;

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

const windowSegment = (window: UsageWindow, now: number): string | undefined => {
  if (window.utilization === null) return undefined;
  // Display REMAINING quota (like pi-usage's codex "remaining" default), clamped at 0.
  const percent = `${Math.max(0, Math.round(100 - window.utilization))}%`;
  if (window.resetsAt !== null) return `${percent} ↻ ${formatCountdown(window.resetsAt, now)}`;
  return percent;
};

export function formatQuotaChip(providerId: string, usage: AccountUsage, now: number): string {
  const segments = [usage.fiveHour, usage.sevenDay]
    .filter((window): window is UsageWindow => window !== null)
    .map((window) => windowSegment(window, now))
    .filter((segment): segment is string => segment !== undefined);
  if (segments.length === 0) {
    return truncateChip(`${CHIP_PREFIX} ${providerId} no usage`);
  }
  return truncateChip(`${CHIP_PREFIX} ${providerId} ${segments.join(" ")}`);
}
