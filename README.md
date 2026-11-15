# openclaw-feishu-progress

An OpenClaw plugin that gives Feishu turns a Namo-style progress card:

- **While a turn runs**: one card replies to the user's message. Its header shows the elapsed time and tool-call count, and the body lists the most recent tool steps (`✅ 运行命令 · 0.3s`, `❌ 抓取网页 · 失败`). The card updates at most every 5 s and refreshes the elapsed time every 15 s.
- **Stop button**: "停止任务" asks for confirmation, then runs `/stop` in the conversation. Only the person who sent the message can use it.
- **When the turn ends**: the card collapses to one grey line, for example `✅ 处理结束 · ⏱️ 22s · 🔧 3 次`. Other outcomes read `⏹️ 已停止`, `❌ 执行失败` or `⚠️ 已中断（服务重启）`. While running, the header shows `⏳ 处理中：…` (`🛑 正在停止：…` after a stop) with `⏱️ 已用时 · 🔧 工具调用` underneath. The answer itself arrives as a separate message.
- **Task title**: the progress header reads `处理中：<request>`. The answer is sent as a card titled with the answer's own first sentence as plain text, for example `✅ 两个都在 main`. A stopped or failed run is titled with the request instead (`⏹️ 已停止：…`, `❌ 失败：…`), because its reply is a generic notice., with a grey `🍯 MiMi · 用时 · 工具调用` footer. That title is what the Feishu chat list previews. The progress title is the first line of the user's message, and both titles are redacted and clipped to 30 characters. The plugin takes over the answer through the `reply_payload_sending` hook, as a message `presentation`. Answers with media, markdown tables or more than 8000 characters keep the stock rendering.
- **Agent plan**: when the agent calls OpenClaw's built-in `progress_card` tool, the card shows its checklist (`📋 计划 2/5`, ☑️/▶️/▫️), the progress bar label and the note above the tool steps. Routing helpers such as `dispatch_action`, `tool_search` and `progress_card` itself do not add step lines.
- **Quick replies get no card**: a card appears only on the first tool call or after 10 s.

Each step shows a Chinese tool label plus a short, redacted detail. For `exec` that is the command, shown as `namo: git log -3 --oneline` when it starts with `cd <dir> &&`. For `web_fetch` it is the host, for `web_search` the query, and for file tools the last two path segments. Details are clipped to 40 characters and `$HOME` becomes `~`. Redaction covers the Feishu app secret, every secret-named env var of the gateway, `sk-`/`ghp_`/`xox*-`/`AKIA` tokens, `Bearer …`, `*token*=`/`*key*=`-style assignments and opaque runs of 32 or more characters. Raw parameters are never shown. Consecutive identical steps merge as `× N`.

## How it works

| Piece | Mechanism |
|---|---|
| Inbound message | `message_received` records message id, sender and session key |
| Run start | `model_call_started` binds the run (`runId`) to the pending message of the same `sessionKey` |
| Steps | `before_tool_call` / `after_tool_call` |
| End | `agent_end`. `/stop` aborts the run before its own `message_received` fires, so a late `/stop` relabels a just-"failed" card as "已停止" |
| Card I/O | The plugin calls the Feishu OpenAPI directly with the app credentials in `channels.feishu`: `im/v1/messages/:id/reply`, then `PATCH` with Card 2.0 and `update_multi`. Writes for one run are serialized |
| Stop button | The button value is the stock `@openclaw/feishu` "ocf1" quick action (`k: "quick", q: "/stop"`). The stock plugin validates the operator and the expiry, then dispatches `/stop` itself. This plugin handles no callbacks |
| Restart | Live cards are listed in `~/.openclaw/feishu-progress/active.json` and collapsed to "已中断" on the next load |

## Install (local path)

The Feishu app must have **card callbacks** (`card.action.trigger`) enabled, using the long connection. Without them the button shows "该应用尚未配置卡片回调".

```json5
// openclaw config patch --file <this>.json5
{
  plugins: {
    allow: [/* existing ids */, "feishu-progress"],   // the array is replaced, so keep the existing ids
    load: { paths: ["~/Works/Seven/openclaw-feishu-progress"] },
    entries: { "feishu-progress": { enabled: true, hooks: { allowConversationAccess: true } } },
  },
  channels: { feishu: { streaming: { mode: "off" } } },  // otherwise a streaming answer card appears next to the progress card
}
```

`allowConversationAccess` is required for `agent_end`. After code edits, run `openclaw plugins reload feishu-progress`. No gateway restart is needed.

Optional `plugins.entries.feishu-progress.config` keys are `updateIntervalMs` (5000), `showAfterMs` (10000), `maxSteps` (8) and `stopButtonTtlMs` (6 h).

## Test

```sh
node --test test/
```

Live verification was done on 2026-11-15 against OpenClaw 2026.11.3 and the MiMi bot. A normal run collapsed to "处理结束". `/stop` sent mid-run collapsed to "已停止" within about 2 s. A one-word reply produced no card.

## License

MIT
