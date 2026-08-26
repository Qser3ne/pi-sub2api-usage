import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDuration } from "../worktime.ts";

test("0ms 显示为 0秒", () => {
  assert.equal(formatDuration(0), "0秒");
});

test("负数按 0 处理", () => {
  assert.equal(formatDuration(-500), "0秒");
});

test("不足 1 分钟只显示秒", () => {
  assert.equal(formatDuration(59_999), "59秒");
});

test("分钟省略小时", () => {
  assert.equal(formatDuration(61_000), "1分1秒");
});

test("整分钟补 0 秒", () => {
  assert.equal(formatDuration(120_000), "2分0秒");
});

test("小时进位", () => {
  assert.equal(formatDuration(3_600_000 + 61_000), "1小时1分1秒");
});

test("整小时显示为 X小时0分0秒", () => {
  assert.equal(formatDuration(7_200_000), "2小时0分0秒");
});
