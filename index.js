import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  buildStopEnvelope,
  META_TOOLS,
  answerTitle,
  canRenderAnswerCard,
  chatTypeFromSessionKey,
  makeRedactor,
  outcomeOf,
  parsePlan,
  renderFinalCard,
  renderAnswerPresentation,
  renderRunningCard,
  requestTitle,
  stepDetail,
} from "./lib.js";

// Cards still showing "处理中" when the gateway stopped. Read on load and
// collapsed to "已中断", so a restart never leaves a card spinning forever.
const ACTIVE_FILE = join(homedir(), ".openclaw", "feishu-progress", "active.json");
const PENDING_TTL_MS = 10 * 60_000;
const IDLE_REFRESH_MS = 15_000;
const LATE_STOP_WINDOW_MS = 10_000;
const RECENT_RUN_TTL_MS = 120_000;

export default definePluginEntry({
  id: "feishu-progress",
  name: "Feishu Progress Card",
  description: "Namo-style Feishu progress card with a stop button",
  register(api) {
    const log = api.logger ?? console;
    const cfg = api.pluginConfig ?? {};
    const opts = {
      updateIntervalMs: cfg.updateIntervalMs ?? 5000,
      maxSteps: cfg.maxSteps ?? 8,
      stopButtonTtlMs: cfg.stopButtonTtlMs ?? 6 * 3600_000,
      // A card appears on the first tool call, or after this long without one.
      // Plain chat replies (Opus takes ~4s for "好") therefore get no card at all.
      showAfterMs: cfg.showAfterMs ?? 10_000,
    };

    /** sessionKey -> latest inbound Feishu message waiting for its run. */
    const pending = new Map();
    /** runId -> run state. */
    const runs = new Map();
    /** sessionKey -> runId of the run currently active there. */
    const activeBySession = new Map();
    /** sessionKey -> last run that ended as "failed", for late /stop relabeling. */
    const recentlyFailed = new Map();
    /** runId -> finished run, kept briefly because the answer is sent around agent_end. */
    const recentRuns = new Map();
    /** sessionKey -> last finished run; the "Agent was aborted" notice after /stop carries no runId of ours. */
    const lastBySession = new Map();

    // ---- Feishu API ------------------------------------------------------
    const feishu = () => api.config?.channels?.feishu ?? {};
    const baseUrl = () => (feishu().domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn");
    let token = { value: "", expiresAt: 0 };

    // Values that must never reach a card: the app secret and every
    // secret-looking environment variable of the gateway process.
    let redactorCache;
    function redactor() {
      if (redactorCache) return redactorCache;
      const values = [appSecret()];
      for (const [k, v] of Object.entries(process.env)) if (/KEY|TOKEN|SECRET|PASSW|AUTH|COOKIE/i.test(k)) values.push(v);
      redactorCache = makeRedactor(values);
      return redactorCache;
    }

    function appSecret() {
      const s = feishu().appSecret;
      if (typeof s === "string") return s;
      if (s && typeof s === "object" && s.source === "env" && typeof s.id === "string") return process.env[s.id];
      return undefined;
    }

    async function tenantToken() {
      if (token.value && Date.now() < token.expiresAt) return token.value;
      const res = await fetch(`${baseUrl()}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ app_id: feishu().appId, app_secret: appSecret() }),
      });
      const data = await res.json();
      if (data.code !== 0 || !data.tenant_access_token) throw new Error(`tenant token: code ${data.code}`);
      token = { value: data.tenant_access_token, expiresAt: Date.now() + (data.expire - 300) * 1000 };
      return token.value;
    }

    async function call(method, path, body) {
      const res = await fetch(`${baseUrl()}${path}`, {
        method,
        headers: { Authorization: `Bearer ${await tenantToken()}`, "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (data.code !== 0) throw new Error(`${method} ${path.split("?")[0]}: code ${data.code} ${data.msg ?? ""}`.trim());
      return data.data;
    }

    const replyCard = (messageId, card, inThread) =>
      call("POST", `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
        msg_type: "interactive",
        content: JSON.stringify(card),
        reply_in_thread: inThread,
      }).then((d) => d.message_id);

    const patchCard = (cardMessageId, card) =>
      call("PATCH", `/open-apis/im/v1/messages/${encodeURIComponent(cardMessageId)}`, { content: JSON.stringify(card) });

    // ---- persistence of cards that are still live --------------------------
    function saveActive() {
      try {
        const live = [];
        for (const r of runs.values()) if (r.cardMessageId && !r.finished) live.push({ cardMessageId: r.cardMessageId, startedAt: r.startedAt, steps: r.steps.length, failed: r.steps.filter((s) => s.status === "failed").length });
        mkdirSync(dirname(ACTIVE_FILE), { recursive: true });
        writeFileSync(ACTIVE_FILE, JSON.stringify(live), { mode: 0o600 });
      } catch (e) {
        log.warn?.(`feishu-progress: save active cards failed: ${e.message}`);
      }
    }

    async function collapseLeftovers() {
      let left = [];
      try { left = JSON.parse(readFileSync(ACTIVE_FILE, "utf8")); } catch { return; }
      if (!Array.isArray(left) || left.length === 0) return;
      for (const item of left) {
        const fake = { steps: Array.from({ length: item.steps ?? 0 }, (_, i) => ({ status: i < (item.failed ?? 0) ? "failed" : "ok" })) };
        try { await patchCard(item.cardMessageId, renderFinalCard(fake, "interrupted", Date.now() - item.startedAt)); }
        catch (e) { log.warn?.(`feishu-progress: collapse leftover card failed: ${e.message}`); }
      }
      saveActive();
    }

    // ---- run lifecycle ------------------------------------------------------
    // All Feishu writes for one run go through run.chain so they never overlap
    // or arrive out of order.
    function enqueue(run, work) {
      run.chain = run.chain.then(work).catch((e) => log.warn?.(`feishu-progress: ${e.message}`));
      return run.chain;
    }

    function ensureCard(run) {
      if (run.cardRequested || run.finished) return;
      run.cardRequested = true;
      clearTimeout(run.showTimer);
      enqueue(run, async () => {
        if (run.finished) return; // turn ended before the card was due
        run.cardMessageId = await replyCard(run.sourceMessageId, renderRunningCard(run, Date.now(), opts), run.chatType === "group");
        run.lastPatchAt = Date.now();
        saveActive();
        scheduleRefresh(run, IDLE_REFRESH_MS);
      });
    }

    function scheduleRefresh(run, delay) {
      if (run.finished || run.refreshTimer) return;
      run.refreshTimer = setTimeout(() => {
        run.refreshTimer = undefined;
        enqueue(run, async () => {
          if (run.finished || !run.cardMessageId) return;
          await patchCard(run.cardMessageId, renderRunningCard(run, Date.now(), opts));
          run.lastPatchAt = Date.now();
        }).then(() => scheduleRefresh(run, IDLE_REFRESH_MS));
      }, delay);
    }

    function markDirty(run) {
      if (!run.cardRequested) return ensureCard(run);
      if (run.finished) return;
      const due = Math.max(0, (run.lastPatchAt ?? 0) + opts.updateIntervalMs - Date.now());
      if (run.refreshTimer) {
        // A refresh is already queued; pull it forward if it is further out than the throttle.
        clearTimeout(run.refreshTimer);
        run.refreshTimer = undefined;
      }
      scheduleRefresh(run, due);
    }

    function startRun(runId, sessionKey) {
      const p = pending.get(sessionKey);
      if (!p || Date.now() - p.at > PENDING_TTL_MS) return undefined;
      pending.delete(sessionKey);
      const chatType = chatTypeFromSessionKey(sessionKey);
      const run = {
        runId,
        sessionKey,
        sourceMessageId: p.messageId,
        title: p.title,
        chatType,
        startedAt: Date.now(),
        steps: [],
        stopRequested: false,
        stopEnvelope: buildStopEnvelope({ senderId: p.senderId, sessionKey, chatType, expiresAt: Date.now() + opts.stopButtonTtlMs }),
        chain: Promise.resolve(),
      };
      runs.set(runId, run);
      activeBySession.set(sessionKey, runId);
      run.showTimer = setTimeout(() => ensureCard(run), opts.showAfterMs);
      return run;
    }

    function finishRun(run, event) {
      if (run.finished) return;
      run.finished = true;
      clearTimeout(run.showTimer);
      clearTimeout(run.refreshTimer);
      if (activeBySession.get(run.sessionKey) === run.runId) activeBySession.delete(run.sessionKey);
      const outcome = outcomeOf(event, run.stopRequested);
      const durationMs = Number(event?.durationMs) || Date.now() - run.startedAt;
      run.outcome = outcome;
      run.durationMs = durationMs;
      run.finishedAt = Date.now();
      lastBySession.set(run.sessionKey, run);
      recentRuns.set(run.runId, run);
      setTimeout(() => recentRuns.delete(run.runId), RECENT_RUN_TTL_MS).unref?.();
      enqueue(run, async () => {
        if (run.cardMessageId) await patchCard(run.cardMessageId, renderFinalCard(run, outcome, durationMs));
      }).finally(() => {
        runs.delete(run.runId);
        saveActive();
      });
      // /stop aborts the run before its own message_received hook fires (observed
      // ~0.1s later), so a stopped run first looks "failed". Keep it briefly so a
      // late /stop can relabel the card.
      if (outcome === "failed") recentlyFailed.set(run.sessionKey, { run, durationMs, at: Date.now() });
    }

    function relabelAsStopped(sessionKey) {
      const recent = recentlyFailed.get(sessionKey);
      recentlyFailed.delete(sessionKey);
      if (!recent || Date.now() - recent.at > LATE_STOP_WINDOW_MS || !recent.run.cardMessageId) return;
      recent.run.outcome = "stopped";
      enqueue(recent.run, () => patchCard(recent.run.cardMessageId, renderFinalCard(recent.run, "stopped", recent.durationMs)));
    }

    const isFeishu = (ctx) => typeof ctx?.sessionKey === "string" && ctx.sessionKey.includes(":feishu:");

    // ---- hooks ---------------------------------------------------------------
    api.on("message_received", async (event, ctx) => {
      try {
        if (!isFeishu(ctx)) return;
        const messageId = ctx.messageId ?? event?.messageId;
        const text = typeof event?.content === "string" ? event.content.trim() : "";
        const activeRun = runs.get(activeBySession.get(ctx.sessionKey));
        if (text.startsWith("/")) {
          // Commands (typed or from our stop button) never start a progress card.
          if (/^\/stop\b/i.test(text)) {
            if (activeRun) { activeRun.stopRequested = true; markDirty(activeRun); }
            else relabelAsStopped(ctx.sessionKey);
          }
          return;
        }
        if (!messageId || String(messageId).startsWith("card-action-")) return;
        pending.set(ctx.sessionKey, { messageId, senderId: ctx.senderId ?? event?.senderId, title: requestTitle(text, redactor()), at: Date.now() });
      } catch (e) { log.warn?.(`feishu-progress: message_received: ${e.message}`); }
    });

    api.on("model_call_started", async (_event, ctx) => {
      try {
        if (!isFeishu(ctx) || !ctx.runId || runs.has(ctx.runId)) return;
        startRun(ctx.runId, ctx.sessionKey);
      } catch (e) { log.warn?.(`feishu-progress: model_call_started: ${e.message}`); }
    });

    api.on("before_tool_call", async (event, ctx) => {
      try {
        const run = runs.get(ctx?.runId ?? event?.runId);
        if (!run || run.finished) return;
        if (event?.toolName === "progress_card") {
          run.plan = parsePlan(event?.params, redactor());
          markDirty(run);
          return undefined;
        }
        if (META_TOOLS.has(event?.toolName)) return undefined;
        let detail;
        try { detail = stepDetail(event?.toolName, event?.params, redactor(), homedir()); } catch { detail = undefined; }
        run.steps.push({ id: event?.toolCallId, name: event?.toolName, detail, status: "running" });
        markDirty(run);
      } catch (e) { log.warn?.(`feishu-progress: before_tool_call: ${e.message}`); }
      return undefined; // observe only, never block
    });

    api.on("after_tool_call", async (event, ctx) => {
      try {
        const run = runs.get(ctx?.runId ?? event?.runId);
        if (!run || run.finished) return;
        const step = [...run.steps].reverse().find((s) => s.status === "running" && (!event?.toolCallId || s.id === event.toolCallId));
        if (!step) return;
        step.status = event?.error ? "failed" : "ok";
        step.durationMs = Number(event?.durationMs);
        markDirty(run);
      } catch (e) { log.warn?.(`feishu-progress: after_tool_call: ${e.message}`); }
    });

    function agentName(sessionKey) {
      const id = /^agent:([^:]+):/.exec(sessionKey ?? "")?.[1];
      const identity = id ? api.config?.agents?.entries?.[id]?.identity : undefined;
      return identity?.name ? `${identity.emoji ? identity.emoji + " " : ""}${identity.name}` : undefined;
    }

    // Replace the stock "🍯 MiMi" answer header with the task title, so the chat
    // list shows which task this answer belongs to. Only plain text finals are
    // taken over; media, tables, long text and existing cards stay stock.
    api.on("reply_payload_sending", async (event, ctx) => {
      try {
        if (event?.kind !== "final") return;
        const runId = event.runId ?? ctx?.runId;
        let run = runs.get(runId) ?? recentRuns.get(runId);
        if (!run) {
          const last = lastBySession.get(event.sessionKey ?? ctx?.sessionKey);
          if (last && last.outcome !== "done" && Date.now() - (last.finishedAt ?? 0) < 15_000) run = last;
        }
        if (!run || !run.title || run.answerCarded) return;
        const p = event.payload ?? {};
        if (p.mediaUrl || (Array.isArray(p.mediaUrls) && p.mediaUrls.length) || p.presentation || p.interactive || p.channelData) return;
        if (!canRenderAnswerCard(p.text)) return;
        run.answerCarded = true;
        const outcome = run.outcome ?? (run.stopRequested ? "stopped" : "done");
        const card = renderAnswerPresentation({
          text: p.text,
          // Done: the answer's own first sentence says what happened. Stopped or
          // failed: the reply is a generic notice, so name the task instead.
          title: (outcome === "done" ? answerTitle(p.text, redactor()) : undefined) ?? run.title,
          outcome,
          agentName: agentName(run.sessionKey),
          durationMs: run.durationMs ?? Date.now() - run.startedAt,
          steps: run.steps,
        });
        // Presentation is the only rich path the stock Feishu renderer honours for
        // replies; text moves into a block so it is not rendered twice.
        return { payload: { ...p, text: undefined, presentation: card } };
      } catch (e) { log.warn?.(`feishu-progress: reply_payload_sending: ${e.message}`); }
    });

    api.on("agent_end", async (event, ctx) => {
      try {
        const run = runs.get(ctx?.runId ?? event?.runId);
        if (run) finishRun(run, event);
      } catch (e) { log.warn?.(`feishu-progress: agent_end: ${e.message}`); }
    });

    collapseLeftovers().catch((e) => log.warn?.(`feishu-progress: leftovers: ${e.message}`));
  },
});
