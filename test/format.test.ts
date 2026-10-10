import { test } from "node:test";
import assert from "node:assert/strict";
import { formatQuotaChip, formatCountdown, truncateChip } from "../src/format.ts";
import type { PlatformQuota, QuotaWindow } from "../src/sub2api.ts";

const NOW = Date.parse("2026-10-10T12:00:00Z");

const window = (usageUsd: number, limitUsd: number | null, resetsAt: number | null = null): QuotaWindow => ({
  usageUsd,
  limitUsd,
  resetsAt,
});

const quota = (daily: QuotaWindow, weekly: QuotaWindow, monthly: QuotaWindow): PlatformQuota => ({
  platform: "openai",
  daily,
  weekly,
  monthly,
});

test("full spec chip with all windows", () => {
  const q = quota(
    window(6.2, 10, NOW + ((4 * 60 + 12) * 60 + 5) * 1000),
    window(31, 100),
    window(12, 100),
  );
  assert.equal(formatQuotaChip("sub2api-gpt", q, NOW), "📊 sub2api-gpt 62% ↻ 4h12m · wk 31% · mo 12%");
});

test("percent uses floor of usage/limit", () => {
  const q = quota(window(6.29, 10), window(0.4, 100), window(99.9, 100));
  const chip = formatQuotaChip("p", q, NOW);
  assert.ok(chip.includes("62%"));
  assert.ok(chip.includes("wk 0%"));
  assert.ok(chip.includes("mo 99%"));
});

test("null limit degrades to used-usd segments", () => {
  const q = quota(window(6.2, null), window(31, null), window(12.4, null));
  const chip = formatQuotaChip("p", q, NOW);
  assert.ok(chip.includes("$6.2"));
  assert.ok(chip.includes("wk $31"));
  assert.ok(chip.includes("mo $12"));
});

test("null daily resetsAt omits the countdown segment", () => {
  const q = quota(window(6.2, 10, null), window(31, 100), window(12, 100));
  assert.equal(formatQuotaChip("p", q, NOW), "📊 p 62% · wk 31% · mo 12%");
});

test("formatCountdown renders compact units", () => {
  const day = 86_400_000;
  assert.equal(formatCountdown(NOW + 3 * day + 13 * 3_600_000, NOW), "3d13h");
  assert.equal(formatCountdown(NOW + 2 * 3_600_000 + 12 * 60_000, NOW), "2h12m");
  assert.equal(formatCountdown(NOW + 45 * 60_000, NOW), "45m");
  assert.equal(formatCountdown(NOW + 12_000, NOW), "12s");
  assert.equal(formatCountdown(NOW, NOW), "0s");
  assert.equal(formatCountdown(NOW - 5_000, NOW), "0s");
});

test("truncateChip caps at 80 chars plus ellipsis", () => {
  const long = "x".repeat(90);
  const cut = truncateChip(long);
  assert.equal(cut.length, 81);
  assert.ok(cut.endsWith("…"));
  assert.equal(truncateChip("short"), "short");
  assert.equal(truncateChip("x".repeat(80)).length, 80);
});
