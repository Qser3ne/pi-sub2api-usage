import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorktimeTracker, monotonicNow, findPersistedTotal } from "../worktime.ts";

test("默认使用单调时钟：短忙等的计时长应在合理区间", () => {
  const t = createWorktimeTracker(); // 不注入时钟，用默认单调钟
  t.start();
  const wallStart = Date.now();
  while (Date.now() - wallStart < 20) {
    /* 忙等约 20ms */
  }
  t.settle();
  assert.ok(t.totalMs >= 5, `计时应接近忙等时长，实际 ${t.totalMs}ms`);
  assert.ok(t.totalMs < 2_000, `不应出现异常膨胀，实际 ${t.totalMs}ms`);
});

test("monotonicNow 单调不减且为有限数值", () => {
  const a = monotonicNow();
  const b = monotonicNow();
  assert.ok(Number.isFinite(a));
  assert.ok(b >= a, `单调性破坏: ${a} -> ${b}`);
});

test("findPersistedTotal 取最后一条 worktime 条目", () => {
  const entries = [
    { type: "message", role: "user" },
    { type: "custom", customType: "worktime", data: { totalMs: 1_000 } },
    { type: "custom", customType: "other", data: { totalMs: 999_999 } },
    { type: "custom", customType: "worktime", data: { totalMs: 2_500 } },
  ];
  assert.equal(findPersistedTotal(entries), 2_500);
});

test("findPersistedTotal：无有效条目或数据损坏时返回 0", () => {
  assert.equal(findPersistedTotal([]), 0);
  assert.equal(findPersistedTotal([{ type: "custom", customType: "worktime", data: { totalMs: "bad" } }]), 0);
  assert.equal(findPersistedTotal([{ type: "custom", customType: "worktime" }]), 0);
});
