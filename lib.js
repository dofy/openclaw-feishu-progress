// Pure helpers: card rendering and the stop-button envelope. No I/O here, so
// everything in this file is covered by test/lib.test.js.

/**
 * Human labels for common tools. Raw parameters are never shown; only the
 * redacted, clipped summary from stepDetail() is.
 */
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

/**
 * Redacts known secret values plus common token shapes. Patterns follow
 * Namo's makeRedactor (src/safety.ts), extended with key=value assignments
 * and long opaque strings.
 */
export function makeRedactor(values = []) {
  const secrets = values.filter((v) => typeof v === "string" && v.length >= 8).sort((a, b) => b.length - a.length);
  return (text) => {
    let out = String(text);
    for (const v of secrets) out = out.split(v).join("[REDACTED]");
    return out
      .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g, "[REDACTED]")
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{12,}/gi, "$1[REDACTED]")
      .replace(/\b([A-Za-z0-9_]*(?:token|secret|passw(?:or)?d|api[_-]?key|auth)[A-Za-z0-9_]*\s*[=:]\s*)(["']?)[^\s"']+\2/gi, "$1[REDACTED]")
      // Long opaque runs (keys, JWT parts). "/" is excluded so long paths survive.
      .replace(/[A-Za-z0-9+_-]{32,}={0,2}/g, "[REDACTED]");
  };
}

const DETAIL_MAX = 40;

function clip(text, max = DETAIL_MAX) {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
}

/**
 * A short, redacted description of what a tool call does: the command for
 * exec, the host for web_fetch, the file name for file tools. Returns
 * undefined when there is nothing safe to show.
 */
export function stepDetail(name, params, redact, home) {
  if (!params || typeof params !== "object") return undefined;
  const tidy = (s) => {
    let t = String(s);
    if (home) t = t.split(home).join("~");
    return clip(redact(t));
  };
  const str = (v) => (typeof v === "string" && v.trim() ? v : undefined);
  switch (name) {
    case "exec": {
      let cmd = str(params.command) ?? str(params.cmd) ?? (Array.isArray(params.command) ? params.command.join(" ") : undefined);
      if (!cmd) return undefined;
      // "cd /long/path/repo && git log" spends the whole budget on the path;
      // show it as "repo: git log" instead.
      const m = cmd.match(/^\s*cd\s+(["']?)([^"'&;]+?)\1\s*(?:&&|;)\s*(.+)$/s);
      if (m) cmd = `${m[2].replace(/\/+$/, "").split("/").pop()}: ${m[3]}`;
      return tidy(cmd);
    }
    case "web_fetch": {
      const url = str(params.url);
      if (!url) return undefined;
      try { return new URL(url).host; } catch { return undefined; }
    }
    case "web_search": {
      const q = str(params.query) ?? str(params.q);
      return q ? tidy(q) : undefined;
    }
    case "read":
    case "write":
    case "edit": {
      const p = str(params.path) ?? str(params.file_path) ?? str(params.filePath);
      return p ? tidy(p.split("/").filter(Boolean).slice(-2).join("/")) : undefined;
    }
    default:
      return undefined;
  }
}

/** Inline code for card markdown; backticks and angle brackets could break the card. */
function codeSpan(text) {
  return "`" + text.replace(/`/g, "'").replace(/</g, "＜").replace(/>/g, "＞") + "`";
}

/** Tool-routing helpers; the inner tool reports its own step, so these add noise. */
export const META_TOOLS = new Set(["dispatch_action", "tool_search", "tool_describe", "progress_card"]);

/**
 * The agent's own plan from OpenClaw's built-in progress_card tool
 * (docs/tools/progress-card.md): ordered steps, an optional <progress> bar
 * and a note. Each call replaces the whole card. Returns undefined to clear.
 */
export function parsePlan(params, redact) {
  if (!params || typeof params !== "object") return undefined;
  const steps = Array.isArray(params.plan)
    ? params.plan
        .filter((p) => p && typeof p.step === "string" && p.step.trim())
        .map((p) => ({ step: clip(redact(p.step), 48), status: ["completed", "in_progress"].includes(p.status) ? p.status : "pending" }))
    : [];
  const md = typeof params.markdown === "string" ? params.markdown : "";
  const barMatch = /<progress[^>]*aria-label="([^"]+)"/i.exec(md) ?? /<progress[^>]*value="(\d+)"[^>]*max="(\d+)"/i.exec(md);
  const bar = barMatch ? (barMatch[2] ? `${barMatch[1]}/${barMatch[2]}` : barMatch[1]) : undefined;
  const noteLine = md
    .replace(/<progress[^>]*>(?:<\/progress>)?/gi, "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("|"));
  const note = noteLine ? clip(redact(noteLine), 60) : undefined;
  if (!steps.length && !bar && !note) return undefined;
  return { steps, bar: bar ? clip(redact(bar), 40) : undefined, note };
}

const PLAN_ICON = { completed: "☑️", in_progress: "▶️", pending: "▫️" };

/** Plan block: done/total, then a window of at most maxSteps around the current step. */
export function renderPlanMarkdown(plan, maxSteps = 6) {
  const lines = [];
  const done = plan.steps.filter((s) => s.status === "completed").length;
  const head = [plan.steps.length ? `**📋 计划 ${done}/${plan.steps.length}**` : undefined, plan.bar ? `📊 ${plan.bar}` : undefined].filter(Boolean);
  if (head.length) lines.push(head.join(" · "));
  if (plan.steps.length) {
    const cur = Math.max(0, plan.steps.findIndex((s) => s.status !== "completed"));
    const start = Math.max(0, Math.min(cur - 1, plan.steps.length - maxSteps));
    const shown = plan.steps.slice(start, start + maxSteps);
    if (start > 0) lines.push(`<font color='grey'>…已完成 ${start} 步</font>`);
    for (const s of shown) lines.push(`${PLAN_ICON[s.status]} ${s.step}`);
    const rest = plan.steps.length - start - shown.length;
    if (rest > 0) lines.push(`<font color='grey'>…还有 ${rest} 步</font>`);
  }
  if (plan.note) lines.push(`<font color='grey'>${plan.note}</font>`);
  return lines.join("\n");
}

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

/**
 * Consecutive finished steps with the same tool and status collapse into one
 * line ("✅ 运行命令 × 3 · 0.7s"), as Namo groups repeated progress lines.
 * Running steps are never merged, so the line being worked on stays visible.
 */
export function groupSteps(steps) {
  const groups = [];
  for (const s of steps) {
    const last = groups.at(-1);
    if (last && s.status !== "running" && last.status === s.status && last.name === s.name && last.detail === s.detail) {
      last.count++;
      if (Number.isFinite(s.durationMs)) last.durationMs = (last.durationMs ?? 0) + s.durationMs;
    } else {
      groups.push({ name: s.name, detail: s.detail, status: s.status, count: 1, durationMs: Number.isFinite(s.durationMs) ? s.durationMs : undefined });
    }
  }
  return groups;
}

function groupLine(g) {
  const label = toolLabel(g.name) + (g.detail ? ` ${codeSpan(g.detail)}` : "") + (g.count > 1 ? ` × ${g.count}` : "");
  if (g.status === "running") return `⏳ ${label}`;
  const dur = Number.isFinite(g.durationMs) ? ` · ${formatDuration(g.durationMs)}` : "";
  if (g.status === "failed") return `❌ ${label} · 失败${dur}`;
  return `✅ ${label}${dur}`;
}

export function renderStepsMarkdown(steps, maxSteps) {
  if (steps.length === 0) return "<font color='grey'>正在思考…</font>";
  const groups = groupSteps(steps);
  const shown = groups.slice(-maxSteps);
  const hiddenSteps = groups.slice(0, groups.length - shown.length).reduce((n, g) => n + g.count, 0);
  const lines = shown.map(groupLine);
  if (hiddenSteps > 0) lines.unshift(`<font color='grey'>…前面还有 ${hiddenSteps} 步</font>`);
  return lines.join("\n");
}

/** Live card: header with elapsed time, recent steps, stop button. */
export function renderRunningCard(run, now, opts) {
  const { total, failed } = countSteps(run.steps);
  const parts = [`⏱️ 已用时 ${formatDuration(now - run.startedAt)}`, `🔧 工具调用 ${total} 次`];
  if (failed) parts.push(`❌ 失败 ${failed} 次`);
  const elements = [];
  if (run.plan) elements.push({ tag: "markdown", content: renderPlanMarkdown(run.plan) }, { tag: "hr" });
  elements.push({ tag: "markdown", content: renderStepsMarkdown(run.steps, opts.maxSteps) });
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
      title: { tag: "plain_text", content: `${run.stopRequested ? "🛑 正在停止" : "⏳ 处理中"}${run.title ? `：${run.title}` : ""}` },
      subtitle: { tag: "plain_text", content: parts.join(" · ") },
      template: run.stopRequested ? "orange" : "blue",
    },
    body: { elements },
  };
}

const OUTCOME_LABEL = {
  done: "✅ 处理结束",
  stopped: "⏹️ 已停止",
  failed: "❌ 执行失败",
  interrupted: "⚠️ 已中断（服务重启）",
};

/** Collapsed card after the turn: one grey line, like Namo's retired progress surface. */
export function renderFinalCard(run, outcome, durationMs) {
  const { total, failed } = countSteps(run.steps);
  const parts = [OUTCOME_LABEL[outcome] ?? OUTCOME_LABEL.done, `⏱️ ${formatDuration(durationMs)}`, `🔧 ${total} 次`];
  if (failed) parts.push(`❌ 失败 ${failed} 次`);
  return {
    schema: "2.0",
    config: { update_multi: true, width_mode: "default" },
    body: {
      elements: [{ tag: "markdown", content: `<font color='grey'>${parts.join(" · ")}</font>`, text_size: "notation" }],
    },
  };
}

const TITLE_MAX = 30;
const TITLE_PREFIX = { done: "✅ ", stopped: "⏹️ 已停止：", failed: "❌ 失败：" };

/**
 * One-line task title from the user's request: first non-empty line, minus a
 * leading "@bot" mention, redacted and clipped. Shown as the answer card's
 * header, which is also what the Feishu chat list previews.
 */
export function requestTitle(text, redact) {
  if (typeof text !== "string") return undefined;
  const line = text.split("\n").map((l) => l.trim()).find(Boolean);
  if (!line) return undefined;
  const cleaned = line.replace(/^@\S+\s+/, "");
  return clip(redact(cleaned), TITLE_MAX) || undefined;
}

/**
 * The answer's own first sentence, as plain text: the shortest statement of
 * what the run concluded. Markdown, code fences, tables and list markers are
 * stripped. The sentence ends at the first 。！？；： after 4 characters,
 * or at .!?;: followed by a space after 8 characters. Returns undefined when nothing usable is left, so the
 * caller can fall back to the request title.
 */
export function answerTitle(text, redact) {
  if (typeof text !== "string") return undefined;
  let inFence = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("```")) { inFence = !inFence; continue; }
    if (inFence || !line || line.startsWith("|") || /^[-*_]{3,}$/.test(line) || line.startsWith(">")) continue;
    const plain = line
      .replace(/^#{1,6}\s+/, "")
      .replace(/^(?:[-*+]|\d+[.)])\s+/, "")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/(\*\*|__|\*|_|~~|`)/g, "")
      .replace(/<[^>]+>/g, "")
      .trim();
    if (!plain) continue;
    // Earliest of: a CJK terminator anywhere, or an ASCII one followed by a
    // space or the end ("$12.40" and "v2.1" keep their dots).
    // ASCII needs 8 leading characters so "Done." does not become the title.
    const cjk = /[。！？；：]/u.exec(plain.slice(4));
    const ascii = /[.!?;:](?=\s|$)/.exec(plain.slice(8));
    const cuts = [cjk && cjk.index + 4, ascii && ascii.index + 8].filter((x) => x != null);
    const sentence = (cuts.length ? plain.slice(0, Math.min(...cuts)) : plain).trim();
    if (Array.from(sentence).length < 2) continue;
    return clip(redact(sentence), TITLE_MAX);
  }
  return undefined;
}

/** Card markdown tables need the stock plugin's table handling; long text needs its chunking. */
export function canRenderAnswerCard(text) {
  if (typeof text !== "string" || !text.trim() || text.length > 8000) return false;
  if (/^\s*\|.*\|\s*$/m.test(text) && /^\s*\|?\s*:?-{3,}/m.test(text)) return false;
  return true;
}

const TITLE_TONE = { done: "success", stopped: "neutral", failed: "danger" };

/**
 * The answer as an OpenClaw message presentation whose title names the task.
 * The stock Feishu plugin renders it as a card with that header, which is
 * also what the chat list previews.
 */
export function renderAnswerPresentation({ text, title, outcome, agentName, durationMs, steps }) {
  const { total, failed } = countSteps(steps ?? []);
  const note = [agentName, durationMs ? `⏱️ ${formatDuration(durationMs)}` : undefined, `🔧 工具调用 ${total} 次`, failed ? `❌ 失败 ${failed} 次` : undefined]
    .filter(Boolean)
    .join(" · ");
  return {
    title: `${TITLE_PREFIX[outcome] ?? TITLE_PREFIX.done}${title}`,
    tone: TITLE_TONE[outcome] ?? "success",
    blocks: [{ type: "text", text }, { type: "divider" }, { type: "context", text: note }],
  };
}

/** Outcome from an agent_end event plus whether a /stop was seen during the run. */
export function outcomeOf(event, stopRequested) {
  if (event && (event.success === true || event.success === "true")) return "done";
  const err = String((event && event.error) ?? "");
  if (stopRequested || /abort/i.test(err)) return "stopped";
  return "failed";
}
