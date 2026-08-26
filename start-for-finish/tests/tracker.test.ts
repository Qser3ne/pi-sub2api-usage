import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorktimeTracker } from "../worktime.ts";

/** 可手动拨动的假时钟。 */
function fakeClock() {
  let now = 1_000_000;
  return {
    advance: (ms: number) => { now += ms; },
    read: () => now,
  };
}

test("settle 后累加一段时长", () => {
  const c = fakeClock();
  const t = createWorktimeTracker(c.read);
  t.start();
  c.advance(5_000);
  assert.equal(t.settle(), true);
  assert.equal(t.totalMs, 5_000);
  assert.equal(t.isRunning, false);
});

test("空闲期间时钟推进不计入", () => {
  const c = fakeClock();
  const t = createWorktimeTracker(c.read);
  t.start();
  c.advance(1_000);
  t.settle();
  c.advance(60_000); // 空闲 1 分钟
  assert.equal(t.totalMs, 1_000);
});

test("空闲时 settle 返回 false 且不改变 totalMs", () => {
  const t = createWorktimeTracker(fakeClock().read);
  assert.equal(t.settle(), false);
  assert.equal(t.totalMs, 0);
});

test("currentRunMs 在运行中实时增长，结算后归零", () => {
  const c = fakeClock();
  const t = createWorktimeTracker(c.read);
  assert.equal(t.currentRunMs(), 0);
  t.start();
  c.advance(2_500);
  assert.equal(t.currentRunMs(), 2_500);
  t.settle();
  assert.equal(t.currentRunMs(), 0);
});

test("start 防重叠：上一段未结算时先结算再开新段", () => {
  const c = fakeClock();
  const t = createWorktimeTracker(c.read);
  t.start();
  c.advance(4_000);
  t.start(); // 未 settle 直接再次 start
  assert.equal(t.totalMs, 4_000);
  c.advance(1_000);
  t.settle();
  assert.equal(t.totalMs, 5_000);
});

test("reset 恢复累计值并终止进行中的段", () => {
  const c = fakeClock();
  const t = createWorktimeTracker(c.read);
  t.start();
  t.reset(42_000);
  assert.equal(t.totalMs, 42_000);
  assert.equal(t.isRunning, false);
  assert.equal(t.currentRunMs(), 0);
});

test("时钟倒退不产生负数", () => {
  let now = 10_000;
  const t = createWorktimeTracker(() => now);
  t.start();
  now = 5_000; // 时钟回拨
  t.settle();
  assert.equal(t.totalMs, 0);
});

test("交互式提问的暂停/恢复序列：用户思考时间不计入", () => {
  const c = fakeClock();
  const t = createWorktimeTracker(c.read);
  t.start();                              // agent_start
  c.advance(4_000);                       // 生成 + 网络往返
  assert.equal(t.settle(), true);         // tool_call(ask_user_question) → 暂停
  c.advance(120_000);                     // 用户思考 2 分钟
  t.start();                              // tool_result → 恢复
  c.advance(3_000);                       // 继续生成至结束
  assert.equal(t.settle(), true);         // agent_settled
  assert.equal(t.totalMs, 7_000);         // 思考的 120s 不计入
});
