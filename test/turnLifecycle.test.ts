import test from "node:test";
import assert from "node:assert/strict";

import { shouldAutoContinueTurn } from "../src/turnLifecycle.js";

test("auto-continues empty realtime replies without tool output", () => {
  assert.equal(
    shouldAutoContinueTurn(
      {
        userText: "帮我看下今天上海天气",
        assistantText: "",
        hadToolOutput: false,
        awaitingInteraction: false,
        continuationCount: 0,
      },
      2,
    ),
    true,
  );
});

test("auto-continues short placeholder replies", () => {
  assert.equal(
    shouldAutoContinueTurn(
      {
        userText: "查一下今天美元汇率",
        assistantText: "我来看看，稍等一下。",
        hadToolOutput: false,
        awaitingInteraction: false,
        continuationCount: 0,
      },
      2,
    ),
    true,
  );
});

test("does not auto-continue finished replies that only start with a transition phrase", () => {
  assert.equal(
    shouldAutoContinueTurn(
      {
        userText: "手机端怎么查性能",
        assistantText: "我来看看，推荐直接用 Instruments 的 Time Profiler 看主线程卡顿。",
        hadToolOutput: false,
        awaitingInteraction: false,
        continuationCount: 0,
      },
      2,
    ),
    false,
  );
});

test("does not auto-continue once the retry budget is exhausted", () => {
  assert.equal(
    shouldAutoContinueTurn(
      {
        userText: "查一下今天黄金价格",
        assistantText: "稍等一下。",
        hadToolOutput: false,
        awaitingInteraction: false,
        continuationCount: 2,
      },
      2,
    ),
    false,
  );
});
