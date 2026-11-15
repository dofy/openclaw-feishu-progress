import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildStopEnvelope,
  chatTypeFromSessionKey,
  formatDuration,
  outcomeOf,
  renderFinalCard,
  renderRunningCard,
  renderStepsMarkdown,
  toolLabel,
} from "../lib.js";

const opts = { maxSteps: 3 };

test("formatDuration", () => {
  assert.equal(formatDuration(40), "0.1s");
  assert.equal(formatDuration(250), "0.3s");
  assert.equal(formatDuration(1200), "1.2s");
  assert.equal(formatDuration(12_400), "12s");
  assert.equal(formatDuration(125_000), "2m05s");
  assert.equal(formatDuration(-1), "0s");
});

test("chatTypeFromSessionKey", () => {
  assert.equal(chatTypeFromSessionKey("agent:main:feishu:direct:ou_1"), "p2p");
  assert.equal(chatTypeFromSessionKey("agent:mimi-group:feishu:group:oc_1:topic:om_1"), "group");
  assert.equal(chatTypeFromSessionKey("agent:main:main"), undefined);
});

test("stop envelope matches the stock Feishu plugin's ocf1 quick action", () => {
  const env = buildStopEnvelope({ senderId: "ou_1", sessionKey: "s", chatType: "p2p", expiresAt: 5 });
  assert.deepEqual(env, { oc: "ocf1", k: "quick", a: "feishu.quick_actions.stop", q: "/stop", c: { u: "ou_1", s: "s", t: "p2p", e: 5 } });
});

test("tool labels never include parameters", () => {
  assert.equal(toolLabel("exec"), "运行命令");
  assert.equal(toolLabel("custom_tool"), "custom_tool");
  assert.equal(toolLabel(undefined), "工具");
});

test("steps markdown keeps only the most recent groups", () => {
  const steps = [
    { name: "exec", status: "ok", durationMs: 300 },
    { name: "exec", status: "ok", durationMs: 300 },
    { name: "web_fetch", status: "failed", durationMs: 1200 },
    { name: "read", status: "ok", durationMs: 40 },
    { name: "exec", status: "running" },
  ];
  const md = renderStepsMarkdown(steps, 3);
  assert.match(md, /前面还有 2 步/); // the merged "exec × 2" group is hidden
  assert.match(md, /❌ 抓取网页 · 失败 · 1\.2s/);
  assert.match(md, /⏳ 运行命令$/);
  assert.equal(renderStepsMarkdown([], 3), "<font color='grey'>正在思考…</font>");
});

test("consecutive identical finished steps merge into one line", () => {
  const steps = [
    { name: "exec", status: "ok", durationMs: 200 },
    { name: "exec", status: "ok", durationMs: 200 },
    { name: "exec", status: "ok", durationMs: 300 },
  ];
  assert.equal(renderStepsMarkdown(steps, 8), "✅ 运行命令 × 3 · 0.7s");
});

test("running and failed steps do not merge with finished ones", () => {
  const steps = [
    { name: "exec", status: "ok", durationMs: 200 },
    { name: "exec", status: "failed", durationMs: 100 },
    { name: "exec", status: "ok", durationMs: 200 },
    { name: "exec", status: "running" },
    { name: "exec", status: "running" },
  ];
  assert.equal(renderStepsMarkdown(steps, 8), ["✅ 运行命令 · 0.2s", "❌ 运行命令 · 失败 · 0.1s", "✅ 运行命令 · 0.2s", "⏳ 运行命令", "⏳ 运行命令"].join("\n"));
});

test("running card has header summary and a confirmed stop button", () => {
  const run = { startedAt: 0, steps: [{ name: "exec", status: "failed", durationMs: 10 }], stopEnvelope: { oc: "ocf1" }, stopRequested: false };
  const card = renderRunningCard(run, 12_000, opts);
  assert.equal(card.schema, "2.0");
  assert.equal(card.config.update_multi, true);
  assert.equal(card.header.subtitle.content, "已用时 12s · 工具调用 1 次 · 失败 1 次");
  const button = card.body.elements.find((e) => e.tag === "button");
  assert.deepEqual(button.behaviors, [{ type: "callback", value: { oc: "ocf1" } }]);
  assert.ok(button.confirm);
  assert.equal(button.disabled, false);
});

test("stop requested disables the button and changes the header", () => {
  const card = renderRunningCard({ startedAt: 0, steps: [], stopEnvelope: {}, stopRequested: true }, 1000, opts);
  assert.equal(card.header.title.content, "正在停止");
  assert.equal(card.body.elements.find((e) => e.tag === "button").disabled, true);
});

test("final card collapses to one grey line without buttons", () => {
  const card = renderFinalCard({ steps: [{ status: "ok" }, { status: "failed" }] }, "stopped", 28_000);
  assert.equal(card.header, undefined);
  assert.equal(card.body.elements.length, 1);
  assert.equal(card.body.elements[0].content, "<font color='grey'>已停止 · 用时 28s · 工具调用 2 次 · 失败 1 次</font>");
});

test("outcomeOf", () => {
  assert.equal(outcomeOf({ success: true }, false), "done");
  assert.equal(outcomeOf({ success: false }, true), "stopped");
  assert.equal(outcomeOf({ success: false, error: "AbortError: x" }, false), "stopped");
  assert.equal(outcomeOf({ success: false, error: "boom" }, false), "failed");
});
