import { test } from "node:test";
import assert from "node:assert/strict";
import { pausesTiming } from "../worktime.ts";

test("交互式提问工具触发暂停计时", () => {
  assert.equal(pausesTiming("ask_user_question"), true);
});

test("普通工具不触发暂停", () => {
  assert.equal(pausesTiming("bash"), false);
  assert.equal(pausesTiming("read"), false);
  assert.equal(pausesTiming(""), false);
});
