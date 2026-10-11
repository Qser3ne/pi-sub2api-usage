import { test } from "node:test";
import assert from "node:assert/strict";
import { formatQuotaChip, formatCountdown, truncateChip } from "../src/format.ts";
import type { AccountUsage, UsageWindow } from "../src/sub2api.ts";

const NOW = Date.parse("2026-10-10T12:00:00Z");

const window = (utilization: number | null, resetsAt: number | null = null): UsageWindow => ({
  utilization,
  resetsAt,
});

const usage = (fiveHour: UsageWindow | null, sevenDay: UsageWindow | null): AccountUsage => ({
  fiveHour,
  sevenDay,
});

test("full codex-style chip shows REMAINING percent with countdowns", () => {
  const u = usage(
    window(0, NOW + ((2 * 60 + 12) * 60 + 5) * 1000),
    window(26, NOW + ((3 * 24 + 13) * 60 * 60) * 1000),
  );
  assert.equal(formatQuotaChip("codex", u, NOW), "📊 codex 100% ↻ 2h12m 74% ↻ 3d13h");
});

test("remaining percent rounds and clamps at zero", () => {
  const u = usage(window(16.4, NOW + 90_000), window(20.5));
  const chip = formatQuotaChip("p", u, NOW);
  assert.ok(chip.includes("84%"), chip);
  assert.ok(chip.includes("80%"), chip);
  const over = usage(window(120, NOW + 90_000), window(0));
  const overChip = formatQuotaChip("p", over, NOW);
  assert.ok(overChip.includes("0%"), overChip);
});

test("null resets_at drops the countdown for that window", () => {
  const u = usage(window(20, null), window(16, null));
  assert.equal(formatQuotaChip("p", u, NOW), "📊 p 80% 84%");
});

test("null window is skipped entirely", () => {
  const u = usage(null, window(16, NOW + 3_600_000));
  assert.equal(formatQuotaChip("p", u, NOW), "📊 p 84% ↻ 1h0m");
});

test("both windows null renders no usage", () => {
  const u = usage(null, null);
  assert.equal(formatQuotaChip("p", u, NOW), "📊 p no usage");
});

test("past resets_at shows 0s countdown", () => {
  const u = usage(window(100, NOW - 1_000), window(50, NOW + 60_000));
  assert.equal(formatQuotaChip("p", u, NOW), "📊 p 0% ↻ 0s 50% ↻ 1m");
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
