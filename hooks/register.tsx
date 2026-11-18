// cache-monitor: draws the cache bar described in docs/RULES.md.
// All decisions live in ./logic.ts; this file only wires events, state and drawing.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Rec } from '../types'
import { assembleBrief, briefPrompt, extractFacts, handoffPath, isValidBrief, parseSkill, savingsLine, seedLine, seedPath, transcriptGuess } from './handoff'
import type { Numbers } from './handoff'
import { PRICES_DATE, WAITING, isDevCopy, addStats, bundledPrices, costs, decide, freshStart, fromSessionStart, handoffSaving, handoffModelSuggestions, hasCounts, isSilentReset, learnTtl, measureFirsts, modelLabel, setMeasured, speedFromTail, summaryUsd, systemLayer, validModel, newerVersion, priceOf, readSettings, sendWarning, setPriceOverride, statsFromTranscript, statsText, sumStats, ttlFor, validatePrices, writeRate } from './logic'
import type { Settings, Stats } from './logic'

const KEEP_MS = 7 * 24 * 60 * 60 * 1000 // saved chats older than this are pruned; an older chat refills on resume
const STATS_KEEP_MS = 90 * 24 * 60 * 60 * 1000 // a chat's /cache-monitor-stats counts (your call); then folded into st:retired
const TOMBSTONE_MS = 365 * 24 * 60 * 60 * 1000 // a retired chat's marker, so a resume doesn't read its history again
const DAY_MS = 24 * 60 * 60 * 1000
const MAX_READ = 4 * 1024 * 1024 // $.fs.read refuses bigger files
const REPO_RAW = 'https://raw.githubusercontent.com/lucabertani/claude-plugin-cache-monitor/main'
const SEED_MS = 30_000 // a handoff line older than this is stale: a later /clear of your own gets an empty box
const SAME_REQUEST_MS = 15 * 60 * 1000 // a resume estimate this close after a saved record is that same request's end
const TAIL_BYTES = 256 * 1024 // the transcript's tail read for the newest reply's speed

// `shape` declines a record an older version stored in another form (no NaN:NaN).
const last = atom({ plugin: 'cache-monitor', key: 'last' } as const, null, { shape: 'rec-2' })
const tick = atom({ plugin: 'cache-monitor', key: 'tick' } as const, 0)
// Closed with the bar's ✕ for this chat; /cache-monitor brings it back.
const hidden = atom({ plugin: 'cache-monitor', key: 'hidden' } as const, false)

// Module variables survive /clear ($.state does not): the handoff line waiting for the
// fresh chat, and the transcript path from the latest SessionStart.
let pendingSeed: { line: string; at: number } | undefined
let transcriptPath: string | undefined

// Clipboard first; if that fails too, a toast shows the line to copy by hand.
async function copyOrSay($: EngineInterface, line: string) {
  const c = await $.ui.copy({ text: line }).catch(() => ({ isCopied: false }))
  $.ui.toast(c.isCopied ? `Handoff line copied. Paste it into a new chat: ${line}` : `Start a new chat and send: ${line}`)
}

// /clear is refused while the session is still busy right after the command (seen live at
// 23:31: rejected before queueing, while Claude Code started its own background request),
// so retry a few times before falling back. Every refusal reason goes to the debug log.
const CLEAR_RETRY_MS = [0, 500, 1_500, 3_000]
async function clearThenSeed($: EngineInterface, line: string) {
  for (const wait of CLEAR_RETRY_MS) {
    if (wait) await $.clock.sleep(wait)
    try {
      await $.command.run({ command: 'clear' })
      return // the clear SessionStart puts the line in the fresh chat's box
    } catch (err) {
      $.ui.log(`cache-monitor: /clear refused after ${wait} ms: ${String(err)}`, { to: 'debug' })
    }
  }
  pendingSeed = undefined
  await copyOrSay($, line)
}

function isRec(v: unknown): v is Rec {
  const r = v as Rec | null
  return !!r && typeof r.at === 'number' && typeof r.prefix === 'number' && typeof r.ttlMin === 'number' && typeof r.model === 'string'
}

async function save($: EngineInterface, rec: Rec | null, sessionId?: string) {
  await update($, last, () => rec)
  // the store is only a backup: the bar runs from memory even when it can't be written
  const key = `cmx:${sessionId ?? (await $.session.id())}`
  await (rec ? $.store.set(key, rec) : $.store.delete(key)).catch(() => {})
}

// Keeps whichever record is newer: memory, store, or one filled in at session start. A session-start
// estimate dates the end of the last reply; a saved record of that same request (its start, its
// output, its reset, its measured TTL) is the accurate one and wins.
async function adopt($: EngineInterface, candidate: Rec | null, sessionId?: string) {
  const kept = await read($, last)
  const stored = await $.store.get(`cmx:${sessionId ?? (await $.session.id())}`).catch(() => undefined)
  const now = await $.clock.now()
  // past the keep time it's as good as pruned (prune runs in the background, maybe later)
  const known = [kept, isRec(stored) && now - stored.at <= KEEP_MS ? stored : null].filter(isRec).filter(r => !r.isEstimate)
  let cand = candidate
  if (cand?.isEstimate) {
    const same = known.find(r => r.at <= cand!.at && cand!.at - r.at <= SAME_REQUEST_MS)
    if (same) cand = null
    else if (known[0]) cand = { ...cand, ttlMin: known[0].ttlMin, ...(known[0].fast ? { fast: true } : {}) }
  }
  const pool = [kept, isRec(stored) && now - stored.at <= KEEP_MS ? stored : null, cand].filter(isRec)
  const pick = pool.sort((a, b) => b.at - a.at)[0] ?? null
  if (pick !== kept) await save($, pick, sessionId)
  return pick
}

// At most once a day, in the background (one store call per key): drops old bar records and
// handoff savings never used, folds chats untouched for 90 days into st:retired and leaves a
// marker, drops empty markers after a year. Folding is one write that also records the chat's
// `<key>@<at>`, so a marker write that fails is retried later without counting it twice; a resumed
// chat's marker gathers new counts, folded again 90 days after its last use.
async function prune($: EngineInterface) {
  const now = await $.clock.now()
  const last = await $.store.get('prunedAt')
  if (typeof last === 'number' && now - last < DAY_MS) return
  await $.store.set('prunedAt', now)
  for (const k of await $.store.keys()) {
    if (k.startsWith('cmx:')) {
      const r = await $.store.get(k)
      if (!isRec(r) || now - r.at > KEEP_MS) await $.store.delete(k)
    } else if (k.startsWith('ho:')) {
      const h = (await $.store.get(k)) as { at?: number } | undefined
      if (typeof h?.at !== 'number' || now - h.at > KEEP_MS) await $.store.delete(k)
    } else if (k.startsWith('st:') && k !== 'st:retired' && k !== 'st:all') {
      const s = (await $.store.get(k)) as (Stats & { at?: number }) | undefined
      if (typeof s?.at !== 'number') await $.store.delete(k)
      else if (s.retired && !hasCounts(s)) {
        if (now - s.at > TOMBSTONE_MS) {
          await $.store.delete(k)
          const r = (await $.store.get('st:retired')) as Stats | undefined
          const folded = Object.fromEntries(Object.entries(r?.folded ?? {}).filter(([id]) => !id.startsWith(`${k}@`)))
          if (r) await $.store.set('st:retired', { ...r, folded })
        }
      } else if (now - s.at > STATS_KEEP_MS) {
        const id = `${k}@${s.at}`
        const r = (await $.store.get('st:retired')) as Stats | undefined
        if (r?.folded?.[id] === undefined) {
          const x = addStats(s, {}, now)
          const sum = addStats(r, { ...x, chats: x.replies > 0 && !s.retired ? 1 : 0 }, now)
          await $.store.set('st:retired', { ...sum, first: undefined, folded: { ...r?.folded, [id]: now } })
        }
        await $.store.set(k, { at: s.at, since: now, isFilled: true, retired: true, ...(s.first ? { first: s.first } : {}) })
      }
    }
  }
}

// What a fresh chat costs, from the first requests of your own chats (st:<chat>.first).
async function measure($: EngineInterface) {
  const firsts: { total: number; read: number }[] = []
  for (const k of await $.store.keys()) {
    if (!k.startsWith('st:') || k === 'st:retired' || k === 'st:all') continue
    const f = ((await $.store.get(k)) as Stats | undefined)?.first
    if (f && typeof f.total === 'number' && typeof f.read === 'number') firsts.push(f)
  }
  setMeasured(measureFirsts(firsts))
}

// /cache-monitor-stats counters, per chat. A turn's counts wait in memory and are written once, at the
// turn's end (or when /cache-monitor-stats asks); All chats is summed from these keys when asked.
// shortcut: a crash mid-turn loses that turn's counts; write per step if that ever matters.
const pending = new Map<string, Partial<Stats>>()
let isInteractive = true // claude -p, the SDK and observer sessions aren't counted

async function count($: EngineInterface, d: Partial<Stats>, sessionId?: string) {
  if (!isInteractive) return
  const key = `st:${sessionId ?? (await $.session.id())}`
  pending.set(key, addStats(pending.get(key), d, 0))
}

// A write that fails puts its counts back, so the next flush tries them again.
async function flush($: EngineInterface) {
  const now = await $.clock.now()
  let error: unknown
  for (const [key, d] of [...pending]) {
    pending.delete(key) // counts arriving during the write start a fresh entry
    try {
      await $.store.set(key, { ...addStats(await $.store.get(key), d, now), at: now })
    } catch (err) {
      pending.set(key, addStats(d, pending.get(key) ?? {}, 0))
      error = err
    }
  }
  if (error) throw error
}

// Chats this process saw start with no transcript: their first reply is a fresh chat's first request.
const newChats = new Set<string>()

// A chat this plugin hasn't counted from its start: read its history from the transcript once
// (4 MiB at most, $.fs.read's limit), adding only what live counting hasn't already. Too big to
// read: counted from now on, and /cache-monitor-stats says "since <date>".
async function fillIn($: EngineInterface, sessionId: string, path: string | undefined, ttlMin: number, isFork: boolean, setting: Settings['memoryMinutes']) {
  if (!isInteractive || !path) return
  const key = `st:${sessionId}`
  const have = (await $.store.get(key)) as Stats | undefined
  if (have?.isFilled || have?.partialSince) return
  const now = await $.clock.now()
  // a fork's transcript copies its parent's rows: count it from its first reply instead
  if (isFork) return void (await $.store.set(key, { ...addStats(have, {}, now), isFilled: true, at: now }))
  const file = await $.fs.stat(path).catch(() => undefined)
  // nothing on disk yet (a new chat): counted live from its first reply, never read back later
  if (!file) {
    newChats.add(sessionId)
    return void (await $.store.set(key, { ...addStats(have, {}, now), isFilled: true, at: now }))
  }
  const isTooBig = (file.size ?? 0) > MAX_READ
  // the transcript holds everything counted live so far, so it replaces those counts
  const chat = isTooBig
    ? { ...addStats(have, {}, now), partialSince: have?.since ?? now }
    : { ...addStats(null, statsFromTranscript(String(await $.fs.read(path)), ttlMin, setting), now), isFilled: true }
  await $.store.set(key, { ...chat, at: now })
}

// Prices /cache-monitor-update saved, checked again on load: a bad or stale table is ignored.
async function loadPrices($: EngineInterface) {
  const v = validatePrices(await $.store.get('prices'), PRICES_DATE)
  // only a table newer than the bundled one: a release's corrected prices always win
  setPriceOverride('error' in v || v.sourceDate <= PRICES_DATE ? null : v.prices)
}

// The newest main-chat reply's speed, from the transcript's tail; undefined when unknown.
async function lastSpeed($: EngineInterface): Promise<boolean | undefined> {
  if (!transcriptPath) return undefined
  try {
    const size = (await $.fs.stat(transcriptPath))?.size ?? 0
    const offset = Math.max(0, size - TAIL_BYTES)
    return speedFromTail(String(await $.fs.read(transcriptPath, { offset, length: TAIL_BYTES })))
  } catch {
    return undefined
  }
}

// Counts a handoff's saving once, to the chat it came from, when its line is sent.
async function creditHandoff($: EngineInterface, path: string) {
  const key = `ho:${path}`
  const h = (await $.store.get(key)) as { from?: string; savedTokens?: number; savedUsd?: number } | undefined
  if (!h || typeof h.from !== 'string') return
  await $.store.delete(key)
  await count($, { savedTokens: Number(h.savedTokens) || 0, savedUsd: Number(h.savedUsd) || 0 }, h.from)
}

export const register: Register = (on, options) => {
  const settings = readSettings(options as Record<string, unknown>)

  on('session.start', async ($, e, next) => {
    isInteractive = e.isInteractive !== false
    // commands and ticker first: a broken store must never cost the user the bar or the commands
    await $.command.register({ name: 'cache-monitor', description: 'Show or hide the cache-monitor bar' })
    await $.command.register({ name: 'cache-monitor-handoff', description: 'Summarize this chat with a cheap model (Haiku by default, see the handoffModel option; the expired cache is never resent) and start a fresh chat from it', argumentHint: '[model: haiku | sonnet | opus | claude-…]' })
    await $.command.register({ name: 'cache-monitor-model', description: 'Show or set the model /cache-monitor-handoff uses (a name from the list, or any model id)', argumentHint: '[haiku | sonnet | opus | claude-…]' })
    await $.command.register({ name: 'cache-monitor-update', description: 'Update cache-monitor to the latest version, or refresh its model prices (reads this plugin\'s GitHub files; sends nothing)' })
    await $.command.register({ name: 'cache-monitor-stats', description: 'Show what cache-monitor counted: handoff savings, cold rebuilds, cache hit rate, for this chat and all chats' })
    // Each second: redraw the bar (it computes from the wall clock, so sleep or a
    // paused timer can't drift it) and pop up once when a big chat's cache expires.
    $.clock.every(1000, () => {
      void (async () => {
        const rec = await read($, last)
        if (!rec) return
        await update($, tick, n => n + 1)
        const v = decide(rec, await $.clock.now(), settings)
        if (rec.warned || !v.shouldPopup || (await read($, hidden))) return
        $.ui.toast(v.text) // the pop-up says exactly what the bar says
        // only mark the record we judged: a reply saved meanwhile stays untouched
        await update($, last, r => (r && r.at === rec.at ? { ...r, warned: true } : r))
        const now = await read($, last)
        if (now && now.at === rec.at) await $.store.set(`cmx:${await $.session.id()}`, now).catch(() => {})
      })().catch(() => {})
    })
    // in the background: never holds up the first prompt
    void prune($).catch(() => {}).then(() => measure($)).catch(() => {})
    await loadPrices($).catch(() => {})
    await adopt($, null).catch(() => {}) // bring back this chat's saved record (app restart, reload)
    return next(e)
  })

  // Older chats and chats resumed inside a running app: Claude Code says how long
  // ago the last reply was and how big the chat is, so the bar can show at once.
  on('classic.SessionStart', async ($, e, next) => {
    if (e.transcript_path) transcriptPath = e.transcript_path
    if (e.session_id) await fillIn($, e.session_id, e.transcript_path, ttlFor(settings.memoryMinutes), e.source === 'fork', settings.memoryMinutes).catch(() => {})
    if (e.source === 'clear') {
      await save($, null, e.session_id)
      // the fresh chat a /cache-monitor-handoff opened: put the line in its box; sending stays the user's
      const seed = pendingSeed
      pendingSeed = undefined
      if (seed && (await $.clock.now()) - seed.at < SEED_MS) {
        const line = seed.line
        void $.prompt.fill({ text: line })
          .then(f => (f.isFilled ? undefined : copyOrSay($, line)))
          .catch(() => copyOrSay($, line))
      }
    } else if (typeof e.seconds_since_last_response === 'number' && e.context_tokens) {
      const now = await $.clock.now()
      const prev = await read($, last)
      const candidate = fromSessionStart({
        secondsSince: e.seconds_since_last_response,
        contextTokens: e.context_tokens,
        model: e.model ?? (await $.session.model()),
        window: (await $.session.usage()).context.window || undefined,
      }, now, prev, settings)
      await adopt($, candidate, e.session_id)
    } else {
      await adopt($, null, e.session_id)
    }
    return next(e)
  }).catch(($, e, next) => next(e)) // fail open: never get in Claude Code's way

  on('turn.step', async function* ($, e, next) {
    const startedAt = await $.clock.now() // the cache is refreshed when the request starts
    const r = yield* next(e)
    if (!e.agentId && r.usage) {
      const u = r.usage
      const prev = await read($, last)
      const prompt = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
      // the lifetime this reply's write used; fast mode from the transcript (lags a step at most)
      const ttlMin = learnTtl(settings.memoryMinutes, u, prev?.ttlMin)
      const fast = (await lastSpeed($)) ?? prev?.fast ?? false
      await save($, {
        at: startedAt,
        prefix: prompt + u.output_tokens,
        out: u.output_tokens,
        model: u.model,
        read: u.cache_read_input_tokens,
        write: u.cache_creation_input_tokens,
        ttlMin,
        miss5: 0,
        warned: false,
        window: (await $.session.usage()).context.window || prev?.window,
        ...(fast ? { fast: true } : {}),
      })
      // a reply sent after this chat's cache expired or was reset paid for a rebuild: its cache write.
      // So did one that read far less than the chat held (a reset with no event of its own).
      const isRebuild = !!prev && (!!prev.resetBy || startedAt > prev.at + prev.ttlMin * 60_000 || isSilentReset(prev, u))
      const p = priceOf(u.model, prompt, fast)
      const writeUsd = p ? (u.cache_creation_input_tokens * writeRate(p.input, ttlMin)) / 1e6 : 0
      const sessionId = await $.session.id()
      const isFirst = newChats.delete(sessionId) // a new chat's first request: what a fresh chat costs
      await count($, {
        replies: 1, read: u.cache_read_input_tokens, write: u.cache_creation_input_tokens, input: u.input_tokens,
        ...(isRebuild ? { rebuilds: 1, rebuildTokens: u.cache_creation_input_tokens, rebuildUsd: writeUsd } : {}),
        ...(isFirst ? { first: { total: prompt, read: u.cache_read_input_tokens } } : {}),
      }, sessionId).catch(() => {})
    }
    return r
  })


  // A real model switch drops the cache at once: re-price on the new model now.
  // `resume` only restores the chat's own model, so its cache is untouched.
  on('classic.PostModelSwitch', async ($, e, next) => {
    const prev = await read($, last)
    if (prev && e.source !== 'resume' && e.from_model !== e.to_model) {
      await save($, {
        ...prev,
        model: e.to_model,
        prefix: e.context_tokens || prev.prefix,
        window: (await $.session.usage()).context.window || prev.window,
        resetBy: 'model',
        warned: false,
      })
    }
    return next(e)
  }).catch(($, e, next) => next(e)) // fail open: never get in Claude Code's way

  // /compact replaces the history with a summary: the old cache is useless and
  // the next request writes a much smaller one.
  on('classic.PostCompact', async ($, e, next) => {
    const prev = await read($, last)
    if (prev) {
      const measured = (await $.session.usage()).context.tokens
      // estimate when the engine has no figure yet (none, or 0): summary at ~4 chars/token plus the system part
      const prefix = measured || Math.round(e.compact_summary.length / 4) + systemLayer()
      // the system prompt layer stays cached through a compaction; the rest is written again
      await save($, { ...prev, prefix, out: 0, cached: Math.min(systemLayer(), prefix), resetBy: 'compact', warned: false })
    }
    return next(e)
  }).catch(($, e, next) => next(e)) // fail open: never get in Claude Code's way

  // Warns (never blocks) when you send into a red chat. Sending a handoff's line is the moment its
  // saving is real: counted then, once per handoff file, to the chat it came from.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer' && !e.command && !(await read($, hidden))) {
      const rec = await read($, last)
      if (rec && decide(rec, await $.clock.now(), settings).light === 'red') $.ui.toast(sendWarning(rec))
    }
    const path = !e.command ? seedPath(e.text) : undefined
    if (path) await creditHandoff($, path).catch(() => {})
    return next(e)
  }).catch(($, e, next) => next(e))


  on('session.end', async ($, e, next) => {
    // the chat is leaving this process (clear, resume into another, exit): drop the
    // in-memory record so the next chat never shows this one's; the store keeps it
    await update($, last, () => null)
    await flush($).catch(() => {})
    return next(e)
  })

  // a turn's /cache-monitor-stats counts are written once, when it ends
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    await flush($).catch(() => {})
    return r
  })

  on('command.run', { command: 'cache-monitor' }, async $ => {
    const isHidden = !(await read($, hidden))
    await update($, hidden, () => isHidden)
    return { text: isHidden ? 'cache-monitor bar hidden. Type /cache-monitor to show it.' : 'cache-monitor bar shown.' }
  })

  // /cache-monitor-update: the plugin's only network use, and only when you run it. GETs of this
  // repo's own files; nothing is sent. A newer version is installed by Claude Code's own
  // updater where the plugin may run it (the terminal); otherwise the reply says how.
  on('command.run', { command: 'cache-monitor-update' }, async $ => {
    const get = async (file: string) => {
      const r = await $.http.fetch(`${REPO_RAW}/${file}`)
      if (!r.ok) throw new Error(`${file}: HTTP ${r.status}`)
      return JSON.parse(r.text) as unknown
    }
    const lines: string[] = []
    // each step reports on its own: a failed price download never hides a finished update
    try {
      const mine = String((JSON.parse(String(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`))) as { version?: unknown }).version)
      const latest = String((await get('.claude-plugin/plugin.json') as { version?: unknown }).version)
      if (!newerVersion(latest, mine)) lines.push(`cache-monitor ${mine} is the latest version.`)
      else if (isDevCopy($.plugin.name)) lines.push(`Version ${latest} is out (this is the dev copy, ${mine}: not updated).`)
      else {
        const run = await $.process.run(['claude', 'plugin', 'update', 'cache-monitor@cache-monitor'], { timeoutMs: 120_000 }).catch((err: unknown) => ({ exitCode: -1, stdout: '', stderr: String(err) }))
        $.ui.log(`cache-monitor: plugin update exit ${run.exitCode}: ${run.stderr.slice(0, 300)}`, { to: 'debug' })
        lines.push(run.exitCode === 0
          ? `Updated cache-monitor ${mine} → ${latest}. Run /reload-plugins (or restart the app) to use it.`
          : `Version ${latest} is out (you have ${mine}). To update: in a terminal run \`claude plugin update cache-monitor@cache-monitor\`, or in the desktop app open + → Plugins → Manage plugins. Then run /reload-plugins. Tip: \`/plugin\` → Marketplaces → cache-monitor → Enable auto-update keeps it current.`)
      }
    } catch (err) {
      lines.push(`Couldn't check for a new version (${String(err).slice(0, 200)}).`)
    }
    try {
      const v = validatePrices(await get('prices.json'), PRICES_DATE)
      if ('error' in v) lines.push(`Prices not changed: the downloaded table was refused (${v.error}).`)
      else if (v.sourceDate <= PRICES_DATE) {
        // not newer than the prices built into this version: those win, and an older download is dropped
        await $.store.delete('prices').catch(() => {})
        setPriceOverride(null)
        lines.push(`Prices: up to date (${PRICES_DATE}).`)
      } else {
        const before = validatePrices(await $.store.get('prices').catch(() => undefined), PRICES_DATE)
        const known = 'error' in before || before.sourceDate <= PRICES_DATE ? bundledPrices().prices : before.prices
        const added = Object.keys(v.prices).filter(k => !(k in known))
        const changed = added.length > 0 || JSON.stringify(v.prices) !== JSON.stringify(known)
        await $.store.set('prices', v).catch(() => {})
        setPriceOverride(v.prices)
        lines.push(changed ? `Prices updated to ${v.sourceDate}${added.length ? `: new ${added.map(k => `claude-${k}`).join(', ')}` : ''}.` : `Prices: up to date (${v.sourceDate}).`)
      }
    } catch (err) {
      lines.push(`Prices not checked (${String(err).slice(0, 200)}).`)
    }
    const isNothingChecked = lines.every(l => l.startsWith("Couldn't") || l.startsWith('Prices not checked'))
    return { text: isNothingChecked ? `cache-monitor: ${lines.join(' ')} Nothing changed.` : lines.join(' ') }
  })

  on('command.run', { command: 'cache-monitor-stats' }, async $ => {
    await flush($).catch(() => {}) // include the turn in progress
    const get = (k: string) => $.store.get(k).catch(() => undefined)
    const now = await $.clock.now()
    const chat = addStats(await get(`st:${await $.session.id()}`), {}, now)
    const keys = (await $.store.keys().catch(() => [] as string[])).filter(k => k.startsWith('st:') && k !== 'st:retired' && k !== 'st:all')
    const all = sumStats(await Promise.all(keys.map(async k => [k, await get(k)] as [string, unknown])), await get('st:retired'), now)
    return { text: statsText(chat, all, settings) }
  })

  // /cache-monitor-handoff: Haiku writes the brief from the chat read locally. Never $.model.fork:
  // it would resend this chat's prefix, the very rebuild a handoff exists to avoid.
  on('command.run', { command: 'cache-monitor-handoff' }, async ($, e) => {
    // `/cache-monitor-handoff sonnet` picks the model for this run; otherwise the handoffModel option
    const args = e.args.trim()
    const model = args ? validModel(args) : settings.handoffModel
    if (!model) return { text: `cache-monitor: "${args.slice(0, 60)}" is not a model name (try haiku, sonnet, opus or a full id like claude-haiku-5-5). Nothing written.` }
    try {
      $.ui.toast('cache-monitor: writing the handoff…')
      const skill = parseSkill(String(await $.fs.read(`${$.plugin.root}/hooks/handoff-skill.md`)))
      const messages = await $.session.messages()
      const sessionId = await $.session.id()
      const now = await $.clock.now()
      const rec = await read($, last)
      const facts = extractFacts(messages)
      const nums: Numbers = rec ? { tokens: rec.prefix, window: rec.window, model: rec.model, bar: decide(rec, now, settings).text } : {}
      const who = modelLabel(model)
      const r = await $.model.complete({
        model,
        system: skill.brief,
        prompt: briefPrompt(messages, facts, nums, skill.closing),
        effort: 'high',
        // the API's ceiling, not a budget. shortcut: no output cap yet; set one from a few real briefs
        maxTokens: 64_000,
        timeoutMs: 180_000, // your call: a slow API gets 3 minutes, then the facts-only file
      })
      const usable = r.isAnswered && r.text.trim() && isValidBrief(r.text, skill.brief) ? r.text : undefined
      const transcript = transcriptPath ?? transcriptGuess(await $.session.cwd(), sessionId)
      const path = handoffPath(now, sessionId)
      const ignore = '.claude/handoffs/.gitignore'
      // briefs quote the chat: the folder ignores itself so `git add -A` never picks them up
      const writeFile = async (brief: string | undefined) => {
        await $.fs.write(path, assembleBrief({ sessionId, transcript, skill, writer: who }, facts, nums, brief))
        if (!(await $.fs.stat(ignore).catch(() => undefined))) await $.fs.write(ignore, '*\n').catch(() => {})
      }
      if (!usable) {
        // a returned failure or a brief without the last request and next steps: like a thrown
        // error, nothing is cleared or counted. The facts are still kept, to use by hand if wanted.
        // Haiku's token counts: out at the cap means it ran out of room.
        const why = !r.isAnswered ? `${who} ${r.reason}` : `${who}'s reply ${r.text.trim() ? 'lacked "Last Request from the User" or "Next Steps"' : 'had no text'}, in ${r.usage.input_tokens} / out ${r.usage.output_tokens} of 64000 tokens`
        const kept = await writeFile(undefined).then(() => ` The facts extracted in code are in ${path}, if you want them.`, () => '')
        return { text: `cache-monitor: no handoff (${why}). This chat is untouched.${kept}` }
      }
      await writeFile(usable)
      const line = seedLine(path)
      const c = rec && costs(rec)
      const haiku = { in: r.usage.input_tokens, out: r.usage.output_tokens, usd: summaryUsd(model, r.usage.input_tokens, r.usage.output_tokens) ?? 0 }
      const fresh = freshStart(settings)
      const main = rec && c ? { model: rec.model, tokens: rec.prefix, cold: c.cold, isCold: ['red', 'orange'].includes(decide(rec, now, settings).light), fresh } : null
      let text = savingsLine({ path, haiku, main })
      // the saving waits until the new chat is used (its line sent), so a handoff run twice or never
      // used is not counted; only when the cache had expired, as the notice says it
      const saved = main?.isCold ? handoffSaving(main.tokens, main.cold, haiku, fresh) : null
      if (saved) await $.store.set(`ho:${path}`, { at: now, from: sessionId, savedTokens: saved.tokens, savedUsd: saved.usd }).catch(() => {})
      await count($, { handoffs: 1 }, sessionId).catch(() => {})
      await flush($).catch(() => {}) // the old chat is about to be cleared: keep its handoff now
      if ((await $.session.surfaces()).includes('desktop')) {
        // desktop reuses the tab on /clear, so the old chat drops out of view, and its own
        // composer refuses a fill (live 00:12, F52): there the old chat stays put
        const c = await $.ui.copy({ text: line }).catch(() => ({ isCopied: false }))
        text += ` To continue, start a new chat and paste${c.isCopied ? ' (auto-copied)' : ''}: ${line}`
        $.ui.toast(text)
        // the desktop app doesn't draw a system notice row (live 00:31, F53): use the command's output
        return { text }
      } else {
        pendingSeed = { line, at: await $.clock.now() } // after Haiku: the call itself may take minutes
        // /clear is refused from inside this hook (measured), so it starts on a timer just
        // after the command returns; the clear SessionStart above puts the line in the new chat's box
        $.clock.after(0, () => void clearThenSeed($, line))
      }
      // a notice row kept in this chat's transcript (the model never reads it), so the line is
      // there whenever the user comes back; command output went unseen after the clear (00:01)
      const kept = await $.session.append({ message: { type: 'system', content: [{ type: 'text', text }] } }).catch(() => ({ deny: 'error' }))
      return kept.deny ? { text } : {}
    } catch (err) {
      return { text: `cache-monitor: no handoff written (${String(err)}). This chat is untouched.` }
    }
  })

  // /cache-monitor-model: a name from the settings picker is set there; any other id sets the
  // picker to "custom" and the id in the free-text field. The change reloads the plugin with it.
  on('command.run', { command: 'cache-monitor-model' }, async ($, e) => {
    const arg = e.args.trim()
    const key = `${$.plugin.name}.handoffModel`
    const picker = (await $.config.list()).find(r => r.key === key)?.options ?? []
    if (!arg) {
      return { text: `Handoff model: ${settings.handoffModel}. Change it with /cache-monitor-model <model>, for example: ${picker.filter(o => o !== 'custom').join(', ')}, or any full model id. One run only: /cache-monitor-handoff <model>.` }
    }
    const model = validModel(arg)
    if (!model) return { text: `"${arg.slice(0, 60)}" is not a model name. Nothing changed.` }
    const isListed = picker.includes(model) && model !== 'custom'
    if (!isListed) {
      const c = await $.config.set({ key: `${$.plugin.name}.handoffModelCustom`, value: model })
      if ('deny' in c && c.deny) return { text: `Couldn't set the model (${c.deny}). Nothing changed.` }
    }
    const p = await $.config.set({ key, value: isListed ? model : 'custom' })
    if ('deny' in p && p.deny) return { text: `Couldn't set the model (${p.deny}). Nothing changed.` }
    return { text: `Handoff model set to ${model}${isListed ? '' : ' (custom)'}. /cache-monitor-handoff uses it from now on.` }
  })

  // Typing "/cache-monitor-handoff s" or "/cache-monitor-model s" offers the models (sonnet, claude-sonnet-5-5, ...) to pick from.
  on('prompt.autocomplete', async ($, e, next) => {
    const r = await next(e)
    const rows = handoffModelSuggestions(e.text, e.start, e.token)
    return rows.length ? { suggestions: [...r.suggestions, ...rows] } : r
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (await read($, hidden)) return next(e)
    const rec = await read($, last)
    await read($, tick) // subscribe so the bar redraws every second
    const text = rec ? decide(rec, await $.clock.now(), settings).text : WAITING
    const { Box, Button, Text } = $.ui.resolve(e)
    // text wraps on the left; ✕ stays pinned top-right however many lines it takes.
    // nowrap + minWidth 0: VS Code's webview otherwise wraps the ✕ onto its own line (P2)
    return (
      <Box key="row" flexDirection="row" flexWrap="nowrap" alignItems="flex-start" gap={1}>
        <Box key="text" flexGrow={1} flexShrink={1} minWidth={0}>
          <Text>{text}</Text>
        </Box>
        <Button key="close" label="✕" plain dimColor onPress={() => update($, hidden, () => true)} />
      </Box>
    )
  })
}
