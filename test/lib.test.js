import assert from "node:assert/strict";
import { test } from "node:test";
import {
  answerTitle,
  buildStopEnvelope,
  chatTypeFromSessionKey,
  formatDuration,
  makeRedactor,
  outcomeOf,
  parsePlan,
  renderPlanMarkdown,
  canRenderAnswerCard,
  renderAnswerPresentation,
  renderFinalCard,
  renderRunningCard,
  renderStepsMarkdown,
  requestTitle,
  stepDetail,
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
  assert.equal(card.header.subtitle.content, "⏱️ 已用时 12s · 🔧 工具调用 1 次 · ❌ 失败 1 次");
  const button = card.body.elements.find((e) => e.tag === "button");
  assert.deepEqual(button.behaviors, [{ type: "callback", value: { oc: "ocf1" } }]);
  assert.ok(button.confirm);
  assert.equal(button.disabled, false);
});

test("stop requested disables the button and changes the header", () => {
  const card = renderRunningCard({ startedAt: 0, steps: [], stopEnvelope: {}, stopRequested: true }, 1000, opts);
  assert.equal(card.header.title.content, "🛑 正在停止");
  assert.equal(card.body.elements.find((e) => e.tag === "button").disabled, true);
});

test("final card collapses to one grey line without buttons", () => {
  const card = renderFinalCard({ steps: [{ status: "ok" }, { status: "failed" }] }, "stopped", 28_000);
  assert.equal(card.header, undefined);
  assert.equal(card.body.elements.length, 1);
  assert.equal(card.body.elements[0].content, "<font color='grey'>⏹️ 已停止 · ⏱️ 28s · 🔧 2 次 · ❌ 失败 1 次</font>");
});

test("redactor removes known values and token shapes", () => {
  const r = makeRedactor(["s3cr3t-value-123"]);
  assert.equal(r("curl -H 'Authorization: Bearer abcdefghijklmnop' x"), "curl -H 'Authorization: [REDACTED] [REDACTED]' x"); // header assignment rule wins; over-redaction is fine
  assert.equal(r("echo s3cr3t-value-123"), "echo [REDACTED]");
  assert.equal(r("gh auth ghp_abcdefghijklmnopqrstuvwxyz12"), "gh auth [REDACTED]");
  assert.equal(r("API_KEY=foo123 node x.js"), "API_KEY=[REDACTED] node x.js");
  assert.equal(r("export OPENAI_API_KEY='sk-zzz'"), "export OPENAI_API_KEY=[REDACTED]");
  assert.equal(r("cd /Users/seven/Works/Seven/openclaw-feishu-progress"), "cd /Users/seven/Works/Seven/openclaw-feishu-progress");
});

test("stepDetail summarizes common tools and clips", () => {
  const r = makeRedactor([]);
  assert.equal(stepDetail("exec", { command: "cd /Users/seven/Works/Seven/namo && git log -3 --oneline" }, r, "/Users/seven"), "namo: git log -3 --oneline");
  assert.equal(stepDetail("exec", { command: "cd '/tmp/a b/' ; ls -la" }, r), "a b: ls -la");
  assert.equal(stepDetail("exec", { command: "git status" }, r), "git status");
  assert.equal(stepDetail("web_fetch", { url: "https://docs.openclaw.ai/tools/x?token=1" }, r), "docs.openclaw.ai");
  assert.equal(stepDetail("read", { path: "/Users/seven/.openclaw/openclaw.json" }, r), ".openclaw/openclaw.json");
  assert.equal(stepDetail("unknown_tool", { a: 1 }, r), undefined);
  assert.equal(stepDetail("exec", undefined, r), undefined);
});

test("detail appears as inline code and splits groups", () => {
  const steps = [
    { name: "exec", detail: "git log a", status: "ok", durationMs: 200 },
    { name: "exec", detail: "git log a", status: "ok", durationMs: 200 },
    { name: "exec", detail: "git log `b` <x>", status: "ok", durationMs: 200 },
  ];
  assert.equal(renderStepsMarkdown(steps, 8), "✅ 运行命令 `git log a` × 2 · 0.4s\n✅ 运行命令 `git log 'b' ＜x＞` · 0.2s");
});

test("outcomeOf", () => {
  assert.equal(outcomeOf({ success: true }, false), "done");
  assert.equal(outcomeOf({ success: false }, true), "stopped");
  assert.equal(outcomeOf({ success: false, error: "AbortError: x" }, false), "stopped");
  assert.equal(outcomeOf({ success: false, error: "boom" }, false), "failed");
});

test("requestTitle takes the first line, strips a mention, redacts and clips", () => {
  const r = makeRedactor([]);
  assert.equal(requestTitle("@MiMi 帮我看下 namo 的测试\n细节…", r), "帮我看下 namo 的测试");
  assert.equal(requestTitle("\n\n  token=abc123 部署一下", r), "token=[REDACTED] 部署一下");
  assert.equal(requestTitle("分别对 ~/Works/Seven 下的 namo、yahaha、sync-text 三个 repo 各跑一次", r), "分别对 ~/Works/Seven 下的 namo、yaha…");
  assert.equal(requestTitle("   ", r), undefined);
});

test("answer presentation carries the task title and a stats note", () => {
  const pres = renderAnswerPresentation({ text: "**done**", title: "跑测试", outcome: "done", agentName: "🍯 MiMi", durationMs: 22_000, steps: [{ status: "ok" }] });
  assert.equal(pres.title, "✅ 跑测试");
  assert.equal(pres.tone, "success");
  assert.deepEqual(pres.blocks, [{ type: "text", text: "**done**" }, { type: "divider" }, { type: "context", text: "🍯 MiMi · ⏱️ 22s · 🔧 工具调用 1 次" }]);
  assert.equal(renderAnswerPresentation({ text: "x", title: "t", outcome: "stopped", steps: [] }).title, "⏹️ 已停止：t");
});

test("tables and long text stay with the stock renderer", () => {
  assert.equal(canRenderAnswerCard("plain **md**"), true);
  assert.equal(canRenderAnswerCard("| a | b |\n|---|---|\n| 1 | 2 |"), false);
  assert.equal(canRenderAnswerCard("x".repeat(9000)), false);
  assert.equal(canRenderAnswerCard(""), false);
});

test("running card header includes the task title", () => {
  const card = renderRunningCard({ startedAt: 0, steps: [], title: "跑测试" }, 1000, { maxSteps: 3 });
  assert.equal(card.header.title.content, "⏳ 处理中：跑测试");
});

test("parsePlan reads progress_card steps, bar and note", () => {
  const r = makeRedactor([]);
  const plan = parsePlan({
    plan: [{ step: "Inspect", status: "completed" }, { step: "Repair", status: "in_progress" }, { step: "Verify", status: "pending" }],
    markdown: '<progress aria-label="PRs reviewed · 12/30" value="12" max="30"></progress>\n\nTwo PRs closed.',
  }, r);
  assert.deepEqual(plan, { steps: [{ step: "Inspect", status: "completed" }, { step: "Repair", status: "in_progress" }, { step: "Verify", status: "pending" }], bar: "PRs reviewed · 12/30", note: "Two PRs closed." });
  assert.equal(parsePlan({}, r), undefined);
  assert.equal(renderPlanMarkdown(plan), "**📋 计划 1/3** · 📊 PRs reviewed · 12/30\n☑️ Inspect\n▶️ Repair\n▫️ Verify\n<font color='grey'>Two PRs closed.</font>");
});

test("long plans show a window around the current step", () => {
  const steps = Array.from({ length: 10 }, (_, i) => ({ step: `s${i}`, status: i < 5 ? "completed" : i === 5 ? "in_progress" : "pending" }));
  const md = renderPlanMarkdown({ steps }, 4);
  assert.equal(md, "**📋 计划 5/10**\n<font color='grey'>…已完成 4 步</font>\n☑️ s4\n▶️ s5\n▫️ s6\n▫️ s7\n<font color='grey'>…还有 2 步</font>");
});

test("answerTitle takes the answer's first sentence as plain text", () => {
  const r = makeRedactor([]);
  assert.equal(answerTitle("两个都在 main 分支：namo 停在今天的 `0d5ab39`，yahaha 停在 9-30。", r), "两个都在 main 分支");
  assert.equal(answerTitle("**余额 $12.40**，本月已用 $7.60。", r), "余额 $12.40，本月已用 $7.60");
  assert.equal(answerTitle("```\nraw\n```\n## 结果\n- yahaha 在 **main** 分支", r), "结果");
  assert.equal(answerTitle("| a | b |\n|---|---|\nnamo 当前在 `main` 分支。", r), "namo 当前在 main 分支");
  assert.equal(answerTitle("Done. All 3 repos checked.", r), "Done. All 3 repos checked");
  assert.equal(answerTitle("```\nonly code\n```", r), undefined);
  assert.equal(answerTitle("三个 repo 跑完了:\n\n**namo**", r), "三个 repo 跑完了");
});
