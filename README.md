# cache-monitor (Claude Code prompt-cache monitor)

Shows, right above the Claude Code prompt, how long Claude's prompt cache stays valid and what your next message will cost. When the cache has expired it suggests a cheap handoff: a small model summarizes the chat and you continue in a fresh, much smaller context.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install cache-monitor --marketplace lucabertani/claude-plugin-cache-monitor
```

Answer `y` to add the marketplace, then pick a scope (user scope = every project).

From a shell:

```
claude plugin install cache-monitor --marketplace lucabertani/claude-plugin-cache-monitor
```

In the desktop app: click **+** next to the prompt box → **Plugins** → **Add marketplace** with `lucabertani/claude-plugin-cache-monitor` → **Add plugin**.

## The bar

One line above the prompt, redrawn every second:

| Light | Meaning |
|---|---|
| 🟢 | Cache is warm: time left, cost of the next message, context size. |
| 🟡 | Less than *Warning time* minutes left (1-hour cache only). Reply soon or hand off. |
| 🟠 | Cache expired, but rebuilding it costs little more than a new chat would: fine to keep going. |
| 🔴 | Cache expired (or reset by a model switch / `/compact`) and rebuilding the part a new chat would not resend costs more than *Rebuild limit*. A one-time pop-up suggests `/cache-monitor-handoff` and shows the estimated saving. |

Example: `🟢 47:05 min left · next message ≈ $0.05 · 228K / 1M · ✅ Keep going`

The ✕ on the right hides the bar for the current chat; `/cache-monitor` brings it back.

How the figures are worked out:

- **Cache lifetime.** Claude Code gives the main chat a 1-hour cache only on a Claude subscription within its plan's usage. On usage credits, an API key or a cloud provider, or with `promptCacheTtl` / `CLAUDE_CODE_PROMPT_CACHE_TTL` / `FORCE_PROMPT_CACHING_5M`, it is 5 minutes ([docs](https://code.claude.com/docs/en/prompt-caching#cache-lifetime)). With `memoryMinutes: auto` the bar reads which one each reply wrote (`ephemeral_1h` / `ephemeral_5m` in its usage) and counts down from that, from the start of the request.
- **Saving.** A new chat is not free: its first prompt resends the system prompt, tools, CLAUDE.md and memory. The saving is the rebuild beyond that (measured from your own chats' first requests, or the *Fresh chat size* setting) and beyond reading the brief, minus the summary model's cost. It can be zero or negative; then the bar does not suggest a handoff.
- **Resets** the bar sees at once: a model switch, `/compact` (the system prompt layer stays cached). Fast mode (read from the transcript) prices at 2x. Resets with no event of their own (fast mode toggled, effort or tools changed, old images dropped) show up in `/cache-monitor-stats` as rebuilds when the reply reads far less than the chat held.

## Commands

| Command | What it does |
|---|---|
| `/cache-monitor` | Show or hide the bar. |
| `/cache-monitor-handoff [model]` | Summarizes the chat with a cheap model (Haiku by default) and starts a fresh chat from the summary. The expired cache is **never** resent to your main model. The summary is saved to `.claude/handoffs/<date>-<id>.md` (git-ignored), always with your last message verbatim. In the terminal and VS Code the chat is cleared and the prompt box is pre-filled with `Read <file> and continue from where we left off.` (not sent: you send it). In the desktop app the line is copied to the clipboard for a new chat. The new chat keeps your current main model. If the model fails or its summary lacks your last request or the next steps, nothing is cleared: the chat is untouched and only a facts-only file is written. |
| `/cache-monitor-model [model]` | Without an argument, shows the current handoff model and the choices. With one, sets it permanently: a listed name sets the picker, any other model id is stored as a custom model. |
| `/cache-monitor-update` | Checks this repository for a newer version (and runs `claude plugin update` where allowed) and refreshes the model price table. |
| `/cache-monitor-stats` | Estimated handoff savings (counted once, when the handoff's line is sent in the new chat), cold rebuilds paid, cache hit rate: this chat and all chats. |

### Choosing the handoff model

- **One run only:** `/cache-monitor-handoff sonnet`
- **Permanently:** `/cache-monitor-model sonnet`, or the settings (below).
- **Autocomplete:** type `/cache-monitor-handoff s` or `/cache-monitor-model s` and a list of models appears (aliases first, then full model ids with their input price).
- Accepted values: an alias (`haiku`, `sonnet`, `opus`, `fable`) or any full model id (`claude-sonnet-5-5`, `claude-sonnet-5-5-20260401`, …). An unknown id is refused by Claude Code when the handoff runs; nothing is cleared, and a file with only the facts extracted in code is written, with the reason.

## Settings

`/plugin` → **cache-monitor** → options, or from a shell:

```
echo '{"handoffModel":"sonnet"}' | claude plugin configure cache-monitor --values-stdin
```

| Option | Default | Meaning |
|---|---|---|
| `handoffModel` | `haiku` | Model used by `/cache-monitor-handoff`. Pick from the list, or `custom` to use `handoffModelCustom`. |
| `handoffModelCustom` | *(empty)* | Any alias or model id; used only when `handoffModel` is `custom`. |
| `rebuildLimitUsd` | `0.5` | Above this rebuild cost (beyond what a new chat costs anyway) the bar turns red and suggests a handoff. |
| `warnMinutes` | `15` | How early the bar turns yellow before the 1-hour cache expires. |
| `longChatTokens` | `300000` | Chat size at which the bar suggests a new chat after the current task. |
| `costStyle` | `dollars` | `dollars` shows approximate $; `times` shows how many times more than a normal message. |
| `memoryMinutes` | `auto` | Cache lifetime: `auto` = learned from each reply (starts at 1 hour); `5` or `60` forces it. |
| `freshChatTokens` | `0` | A new chat's first prompt in tokens; `0` = measured from your own chats (35000 until 5 chats are measured). |

Run `/reload-plugins` after changing settings from a shell.

## Privacy

- The plugin reads the chat **locally**. The only data that leaves your machine is the abbreviated chat sent by `/cache-monitor-handoff` to the model you chose, through Claude Code's own Anthropic connection.
- The only network request of its own is `/cache-monitor-update`, and only when you run it: two GETs of this repository's files (`.claude-plugin/plugin.json`, `prices.json`). Nothing is sent.
- Stored locally: per-chat counters (numbers only, never chat text) and the handoff files in `.claude/handoffs/`.

## Development

```
claude plugin validate .
claude plugin test .
```

Logic lives in `hooks/logic.ts` (pure, tested), wiring in `hooks/register.tsx`, the handoff in `hooks/handoff.ts` and the prompt given to the summary model in `hooks/handoff-skill.md`. Prices: `bun scripts/prices-json.ts` regenerates `prices.json` from the bundled table.

## License

MIT
