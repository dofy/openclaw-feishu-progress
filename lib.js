// Pure helpers: card rendering and the stop-button envelope. No I/O here, so
// everything in this file is covered by test/lib.test.js.

/** Human labels for common tools. Parameters are never shown: they can hold paths or secrets. */
const TOOL_LABELS = {
  exec: "运行命令",
  process: "管理进程",
  read: "读取文件",
  write: "写入文件",
  edit: "修改文件",
  apply_patch: "修改文件",
  web_search: "网页搜索",
  web_fetch: "抓取网页",
  browser: "浏览器",
  memory_search: "检索记忆",
  memory_get: "读取记忆",
  message: "发送消息",
  image: "处理图片",
  sessions_spawn: "启动子任务",
  tool_search: "查找工具",
  tool_describe: "查看工具说明",
  dispatch_action: "调用工具",
};

export function toolLabel(name) {
  if (typeof name !== "string" || !name) return "工具";
  return TOOL_LABELS[name] ?? name;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  if (ms < 100) return "0.1s"; // no "<": Feishu card markdown would read it as a tag
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, "0")}s`;
}

/** "direct" or "group" from an OpenClaw Feishu session key, e.g. agent:main:feishu:direct:ou_x. */
export function chatTypeFromSessionKey(sessionKey) {
  if (typeof sessionKey !== "string") return undefined;
  if (sessionKey.includes(":feishu:direct:")) return "p2p";
  if (sessionKey.includes(":feishu:group:")) return "group";
  return undefined;
}

/**
 * Button value understood by the stock @openclaw/feishu plugin ("ocf1" quick action).
 * On click it validates the operator (u) and expiry (e), then runs `/stop` in the
 * session as if the operator had typed it. Verified end to end on 2026-11-15.
 */
export function buildStopEnvelope({ senderId, sessionKey, chatType, expiresAt }) {
  const c = { e: expiresAt };
  if (senderId) c.u = senderId;
  if (sessionKey) c.s = sessionKey;
  if (chatType) c.t = chatType;
  return { oc: "ocf1", k: "quick", a: "feishu.quick_actions.stop", q: "/stop", c };
}

export function countSteps(steps) {
  let failed = 0;
  for (const s of steps) if (s.status === "failed") failed++;
  return { total: steps.length, failed };
}

function stepLine(step) {
  const label = toolLabel(step.name);
  if (step.status === "running") return `⏳ ${label}`;
  const dur = Number.isFinite(step.durationMs) ? ` · ${formatDuration(step.durationMs)}` : "";
  if (step.status === "failed") return `❌ ${label} · 失败${dur}`;
  return `✅ ${label}${dur}`;
}

export function renderStepsMarkdown(steps, maxSteps) {
  if (steps.length === 0) return "<font color='grey'>正在思考…</font>";
  const shown = steps.slice(-maxSteps);
  const hidden = steps.length - shown.length;
  const lines = shown.map(stepLine);
  if (hidden > 0) lines.unshift(`<font color='grey'>…前面还有 ${hidden} 步</font>`);
  return lines.join("\n");
}

/** Live card: header with elapsed time, recent steps, stop button. */
export function renderRunningCard(run, now, opts) {
  const { total, failed } = countSteps(run.steps);
  const parts = [`已用时 ${formatDuration(now - run.startedAt)}`, `工具调用 ${total} 次`];
  if (failed) parts.push(`失败 ${failed} 次`);
  const elements = [
    { tag: "markdown", content: renderStepsMarkdown(run.steps, opts.maxSteps) },
  ];
  if (run.stopEnvelope) {
    elements.push({
      tag: "button",
      text: { tag: "plain_text", content: run.stopRequested ? "正在停止…" : "停止任务" },
      type: "default",
      disabled: Boolean(run.stopRequested),
      confirm: {
        title: { tag: "plain_text", content: "停止这项任务？" },
        text: { tag: "plain_text", content: "已发生的操作不会自动撤销。" },
      },
      behaviors: [{ type: "callback", value: run.stopEnvelope }],
    });
  }
  return {
    schema: "2.0",
    config: { update_multi: true, width_mode: "default" },
    header: {
      title: { tag: "plain_text", content: run.stopRequested ? "正在停止" : "处理中" },
      subtitle: { tag: "plain_text", content: parts.join(" · ") },
      template: run.stopRequested ? "orange" : "blue",
    },
    body: { elements },
  };
}

const OUTCOME_LABEL = {
  done: "处理结束",
  stopped: "已停止",
  failed: "执行失败",
  interrupted: "已中断（服务重启）",
};

/** Collapsed card after the turn: one grey line, like Namo's retired progress surface. */
export function renderFinalCard(run, outcome, durationMs) {
  const { total, failed } = countSteps(run.steps);
  const parts = [OUTCOME_LABEL[outcome] ?? OUTCOME_LABEL.done, `用时 ${formatDuration(durationMs)}`, `工具调用 ${total} 次`];
  if (failed) parts.push(`失败 ${failed} 次`);
  return {
    schema: "2.0",
    config: { update_multi: true, width_mode: "default" },
    body: {
      elements: [{ tag: "markdown", content: `<font color='grey'>${parts.join(" · ")}</font>`, text_size: "notation" }],
    },
  };
}

/** Outcome from an agent_end event plus whether a /stop was seen during the run. */
export function outcomeOf(event, stopRequested) {
  if (event && (event.success === true || event.success === "true")) return "done";
  const err = String((event && event.error) ?? "");
  if (stopRequested || /abort/i.test(err)) return "stopped";
  return "failed";
}
