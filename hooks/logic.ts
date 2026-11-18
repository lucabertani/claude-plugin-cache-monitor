// Pure logic for the cache-monitor bar: prices, TTL learning, and the rules in
// docs/RULES.md. No $ here, so it is testable on its own and shared by every surface.
import type { Rec } from '../types'

export type Settings = {
  rebuildLimitUsd: number
  warnMinutes: number
  longChatTokens: number
  costStyle: 'dollars' | 'times'
  memoryMinutes: 'auto' | '5' | '60'
  handoffModel: string // the model /cache-monitor-handoff summarizes with: an alias (haiku) or a full model id
  freshChatTokens: number // a fresh chat's first prompt in tokens; 0 = measured from your own chats
}

export const DEFAULTS: Settings = {
  rebuildLimitUsd: 0.5,
  warnMinutes: 15,
  longChatTokens: 300_000,
  costStyle: 'dollars',
  memoryMinutes: 'auto',
  handoffModel: 'haiku',
  freshChatTokens: 0,
}

// USD per million tokens: [input, cache read], keyed by exact family-version.
// Source: claude-api skill price list (cached 2026-11-03); rows marked * checked on
// 2026-11-17 against platform.claude.com/docs/en/about-claude/pricing (input and cache-hit
// columns match). shortcut: M1 moves this to prices.json with a sourceDate.
const PRICES: Record<string, [input: number, read: number]> = {
  'fable-5-2': [8, 0.2],
  'mythos-5-2': [8, 0.2],
  'fable-5-1': [10, 0.25],
  'mythos-5-1': [10, 0.25],
  'fable-5': [10, 1],
  'mythos-5': [10, 1], // *
  'opus-5-5': [4, 0.2],
  'opus-5': [5, 0.5], // *
  'opus-4-8': [5, 0.5], // *
  'opus-4-7': [5, 0.5], // *
  'opus-4-6': [5, 0.5], // *
  'opus-4-5': [5, 0.5], // *
  'opus-4-1': [15, 1.5], // retired on most platforms; pricing page, 2026-11-17
  'opus-4': [15, 1.5], // retired on most platforms; pricing page, 2026-11-17
  'sonnet-5-5': [2, 0.1],
  'sonnet-5': [2, 0.2], // *
  'sonnet-4-6': [3, 0.3], // *
  'sonnet-4-5': [3, 0.3], // *
  'sonnet-4': [3, 0.3], // retired on most platforms; pricing page, 2026-11-17
  'haiku-5-5': [0.1, 0.01],
  'haiku-4-5': [1, 0.1], // *
}

// Exact version match: 'claude-opus-5-6' is unknown, not Opus 5's price. Accepts
// platform prefixes (anthropic., us.anthropic.), dates, [1m], @versions and -fast.
// The day PRICES was last checked; a downloaded table older than this is refused (/cache-monitor-update).
export const PRICES_DATE = '2026-11-17'
export const bundledPrices = () => ({ sourceDate: PRICES_DATE, prices: PRICES })

// Prices /cache-monitor-update downloaded (validated), used over the bundled table until a newer release.
let priceOverride: Record<string, [number, number]> | null = null
export function setPriceOverride(p: Record<string, [number, number]> | null) {
  priceOverride = p
}

// 'claude-opus-5-5-20260401' → family opus, version 5.5; old-style ids ('claude-3-7-sonnet') don't parse.
function parseModel(model: string): { key: string; family: string; v: [number, number] } | null {
  const m = /claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?=$|-\d{8}|\[|@|-v\d|-fast|:)/.exec(model.toLowerCase())
  if (!m) return null
  return { key: m[3] ? `${m[1]}-${m[2]}-${m[3]}` : `${m[1]}-${m[2]}`, family: m[1]!, v: [Number(m[2]), Number(m[3] ?? 0)] }
}

// True for a model newer than every priced one of its family (or a family not priced at all):
// the moment /cache-monitor-update helps. An old unpriced model (Sonnet 3.7) is not "new".
export function isNewModel(model: string): boolean {
  const m = parseModel(model)
  if (!m) return false
  const known = Object.keys({ ...PRICES, ...priceOverride }).map(k => parseModel(`claude-${k}`)).filter(k => k?.family === m.family)
  return known.every(k => m.v[0] > k!.v[0] || (m.v[0] === k!.v[0] && m.v[1] > k!.v[1]))
}

// `prompt`: the request's whole prompt (input + cache read + cache write), which picks Haiku 5.5's tier.
// `fast`: the reply came at fast-mode speed (usage.speed "fast"; the model id stays the plain one).
export function priceOf(model: string, prompt: number, fast = false): { input: number; read: number } | null {
  const id = model.toLowerCase()
  const parsed = parseModel(id)
  if (!parsed) return null
  const key = parsed.key
  const p = priceOverride?.[key] ?? PRICES[key]
  if (!p) return null
  const tier = key === 'haiku-5-5' && prompt > 100_000 ? 5 : 1 // Haiku 5.5 bills prompts over 100K at 5x
  // fast mode costs 2x (Opus 5.5 $8/M in, Fable 5.2 $16/M); an id with -fast is an older deployment form
  const speed = fast || id.includes('-fast') ? 2 : 1
  return { input: p[0] * tier * speed, read: p[1] * tier * speed }
}

export const writeRate = (input: number, ttlMin: number) => input * (ttlMin >= 60 ? 2 : 1.25)

// warm: the cached part is read; the last reply's output (and your new message) is
// written. cold: everything is written, except `cached` (the system prompt layer a
// compaction keeps). Writes cost 1.25x (5m) or 2x (1h) of input.
export function costs(rec: Rec): { warm: number; cold: number } | null {
  const p = priceOf(rec.model, rec.prefix, rec.fast)
  if (!p) return null
  const write = writeRate(p.input, rec.ttlMin)
  // a record from an older version may lack `out`: treat it as 0, never NaN
  const out = Number.isFinite(rec.out) ? Math.min(rec.out, rec.prefix) : 0
  const kept = Number.isFinite(rec.cached) ? Math.min(Math.max(0, rec.cached!), rec.prefix) : 0
  return { warm: ((rec.prefix - out) * p.read + out * write) / 1e6, cold: (kept * p.read + (rec.prefix - kept) * write) / 1e6 }
}

// The cache lifetime before anything was measured. Claude Code gives the main chat 1h only on a
// subscription within its plan's usage; usage credits, an API key, a cloud provider or
// promptCacheTtl / CLAUDE_CODE_PROMPT_CACHE_TTL / FORCE_PROMPT_CACHING_5M give 5 minutes
// (code.claude.com/docs/en/prompt-caching#cache-lifetime). `auto` starts at 1h and learns from each reply.
export function ttlFor(setting: Settings['memoryMinutes']): number {
  return setting === 'auto' ? 60 : Number(setting)
}

// `auto`: the lifetime the reply's own cache write used (usage.cache_creation's ephemeral_1h /
// ephemeral_5m); a reply that wrote nothing keeps what was known, since a read keeps the entry's TTL.
// A write with no split at all (a provider that reports none) is 5 minutes, as /cost prices it.
export function learnTtl(setting: Settings['memoryMinutes'], u: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number; cache_creation_input_tokens?: number }, known?: number): number {
  if (setting !== 'auto') return Number(setting)
  if ((u.ephemeral_1h_input_tokens ?? 0) > 0) return 60
  if ((u.ephemeral_5m_input_tokens ?? 0) > 0) return 5
  if ((u.cache_creation_input_tokens ?? 0) > 0 && u.ephemeral_1h_input_tokens === undefined && u.ephemeral_5m_input_tokens === undefined) return 5
  return known ?? 60
}

// The engine's own TTL word ('5m' | '1h', as PostModelSwitch says it) in minutes.
export const ttlFromEngine = (setting: Settings['memoryMinutes'], ttl: unknown, known: number) =>
  setting !== 'auto' ? Number(setting) : ttl === '5m' ? 5 : ttl === '1h' ? 60 : known

// A reply that read far less than the chat held, while the cache should have been alive:
// something reset it (fast mode toggled, effort or tools changed, old images dropped, a skill's model).
export function isSilentReset(prev: { prefix: number; out?: number }, u: { cache_read_input_tokens: number; cache_creation_input_tokens: number }): boolean {
  const expected = prev.prefix - (Number.isFinite(prev.out) ? prev.out! : 0)
  return expected >= 10_000 && u.cache_creation_input_tokens >= 2_048 && u.cache_read_input_tokens < expected * 0.5
}

// Speed of the newest main-chat reply in a transcript's tail: the engine's usage has no speed field.
export function speedFromTail(tail: string): boolean | undefined {
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!
    if (!l.includes('"speed"') || !l.includes('"assistant"')) continue
    try {
      const d = JSON.parse(l) as { type?: string; isSidechain?: boolean; message?: { usage?: { speed?: string } } }
      if (d.type !== 'assistant' || d.isSidechain) continue
      const s = d.message?.usage?.speed
      if (typeof s === 'string') return s === 'fast'
    } catch { /* a line cut by the tail */ }
  }
  return undefined
}

// Aliases accepted by the handoffModel setting, mapped to the model they price as.
const ALIASES: Record<string, string> = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', fable: 'claude-fable-5-2' }
export const resolveModel = (model: string) => ALIASES[model.trim().toLowerCase()] ?? model.trim()

// "Haiku", "Sonnet"... for messages; the id itself for anything else.
export function modelLabel(model: string): string {
  const f = /opus|sonnet|haiku|fable|mythos/.exec(resolveModel(model).toLowerCase())?.[0]
  return f ? f.replace(/^./, c => c.toUpperCase()) : model
}

// The summary model's cost for a handoff; output is 5x the input rate (FACTS F48b for Haiku 5.5).
// null: no price known for that model.
export function summaryUsd(model: string, inTok: number, outTok: number): number | null {
  const p = priceOf(resolveModel(model), inTok)
  return p ? (inTok * p.input + outTok * p.input * 5) / 1e6 : null
}

// Models offered when choosing the handoff model: the aliases, then every priced model id,
// newest first, each with its input price. Any other id still works when typed in full.
const ALIAS_NOTES: Record<string, string> = { haiku: 'cheapest, default', sonnet: 'balanced', opus: 'best summary, costs more', fable: 'top model, costs the most' }
export function modelChoices(): { text: string; description: string }[] {
  const table = { ...PRICES, ...priceOverride }
  const priced = (id: string) => { const p = priceOf(id, 0); return p ? `$${p.input}/M tokens in` : 'price unknown' }
  const aliases = Object.keys(ALIASES).map(a => ({ text: a, description: `→ ${ALIASES[a]} · ${ALIAS_NOTES[a]} · ${priced(ALIASES[a]!)}` }))
  const ids = Object.keys(table)
    .map(k => parseModel(`claude-${k}`)!)
    .sort((a, b) => a.family.localeCompare(b.family) || b.v[0] - a.v[0] || b.v[1] - a.v[1])
    .map(m => ({ text: `claude-${m.key}`, description: priced(`claude-${m.key}`) }))
  return [...aliases, ...ids]
}

// Typeahead rows for "/cache-monitor-handoff <model>" and "/cache-monitor-model <model>": only for the first argument.
export function handoffModelSuggestions(text: string, start: number, token: string): { text: string; description: string }[] {
  const m = /^\/cache-monitor-(?:handoff|model)[ \t]+/.exec(text)
  if (!m || start !== m[0].length) return []
  const t = token.toLowerCase()
  return modelChoices().filter(c => c.text.includes(t)).slice(0, 15)
}

export const haikuUsd = (inTok: number, outTok: number): number => summaryUsd('haiku', inTok, outTok)!

// What a handoff costs before it runs. Estimate: the chat sent to Haiku is capped at 150,000
// chars (~37.5K tokens) plus facts and instructions; briefs ran 13.8-15.6K chars (F46, F47).
// Four real handoffs used 12K-46K in+out, so this is the top: the bar never promises more than the notice reports.
export const HAIKU_ESTIMATE = { in: 40_000, out: 5_000 }

// A fresh chat is not free: its first prompt resends the system prompt, tools, CLAUDE.md and memory.
// That part costs the same in the old chat and the new one (both read it if another session keeps
// it warm, both write it if not), so only the chat beyond it is saved. Measured from your own chats'
// first requests (median, 5 or more), else the freshChatTokens setting, else this default
// (median first prompt over 119 of the author's chats: 36.6K).
export const FRESH_START_DEFAULT = 35_000
export const BRIEF_TOKENS = 4_000 // the new chat reads the brief: briefs ran 13.8-15.6K chars
export const SYSTEM_LAYER_DEFAULT = 20_000 // the system prompt and tools, still cached after a compaction

let measured: { fresh?: number; system?: number } = {}
export function setMeasured(m: { fresh?: number; system?: number }) {
  measured = m
}
export const freshStart = (s: Settings) => (s.freshChatTokens > 0 ? s.freshChatTokens : measured.fresh ?? FRESH_START_DEFAULT)
export const systemLayer = () => measured.system ?? SYSTEM_LAYER_DEFAULT

// Medians of the first requests /cache-monitor-stats keeps per chat; null below 5 samples.
export function measureFirsts(firsts: { total: number; read: number }[]): { fresh?: number; system?: number } {
  const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]! }
  const ok = firsts.filter(f => Number.isFinite(f.total) && f.total > 0)
  const reads = ok.map(f => f.read).filter(r => Number.isFinite(r) && r > 0)
  return { ...(ok.length >= 5 ? { fresh: med(ok.map(f => f.total)) } : {}), ...(reads.length >= 5 ? { system: med(reads) } : {}) }
}

// The one saving calculation, for the bar (Haiku estimated) and the handoff's notice (Haiku measured):
// the rebuild beyond a fresh chat's own start and the brief, minus what Haiku read, wrote and cost.
// Negative when a fresh chat costs about as much as the rebuild: the handoff then saves nothing.
// isWorth: the one rule the bar, the notice and the stats all use (both figures above zero).
export function handoffSaving(prefix: number, cold: number, haiku: { in: number; out: number; usd: number } | null, fresh = FRESH_START_DEFAULT) {
  const beyond = prefix - fresh - BRIEF_TOKENS
  const tokens = beyond - (haiku ? haiku.in + haiku.out : 0)
  const usd = (prefix > 0 ? (cold * beyond) / prefix : 0) - (haiku?.usd ?? 0) // cold / prefix: the write rate
  return { tokens, usd, isWorth: tokens > 0 && usd > 0 }
}

export type Light = 'green' | 'yellow' | 'orange' | 'red'
export type Verdict = { light: Light; text: string; shouldPopup: boolean }

// Cents. The ratio comes from exact amounts, so it can differ slightly from the
// rounded ones shown ($0.05 × 40 ≠ $1.82 is expected; you chose cents anyway).
export function money(usd: number): string {
  if (usd < 0) return `-${money(-usd)}`
  if (usd < 0.01) return '<$0.01'
  const cents = Math.round(usd * 100) / 100 // round first: $9.996 shows "$10", like every amount from $10 up
  return `$${cents < 10 ? cents.toFixed(2) : cents.toFixed(0)}`
}

// What the bar suggests instead of commanding (built in 0.2.0)
export const HANDOFF = '/cache-monitor-handoff'
const SUGGEST_NEW = `🔄 Try ${HANDOFF} or a new chat`
const RESET_LABEL = { model: 'cache reset (model changed)', compact: 'cache reset (chat compacted)' } as const

// 290K, 1M, 1.5M, 850: short token counts for the context field
export function tokens(n: number): string {
  if (n >= 999_500) return `${Number((n / 1e6).toFixed(1))}M` // 999,500 would round to "1000K"
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`
  return String(n)
}

// 47:05, 60:00 for a full hour, or 1:02:05 past an hour
export function clock(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000))
  if (t <= 3600) return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const sec = String(t % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

// The rules of docs/RULES.md, top to bottom; first match wins. The light says
// the state, so the text is only: time, next-message cost, context, recommendation.
export function decide(rec: Rec, now: number, s: Settings): Verdict {
  const v = decideBase(rec, now, s)
  // no price for this model (likely a new one): the moment /cache-monitor-update helps
  return costs(rec) || !isNewModel(rec.model) ? v : { ...v, text: `${v.text} · new model? try /cache-monitor-update` }
}

function decideBase(rec: Rec, now: number, s: Settings): Verdict {
  // never more than the lifetime itself (a clock set back, a record from the "future")
  const left = Math.min(rec.at + rec.ttlMin * 60_000 - now, rec.ttlMin * 60_000)
  const c = costs(rec)
  const r = c && c.warm > 0 ? Math.round(c.cold / c.warm) : null
  const ratio = r && r >= 2 ? r : null // "(1× more)" says nothing: leave it out
  const dollars = s.costStyle === 'dollars' && c !== null
  const more = ratio ? ` (${ratio}× more)` : ''
  const ctx = rec.window ? ` · ${tokens(rec.prefix)} / ${tokens(rec.window)}` : ''
  const nextWarm = dollars ? `next message ≈ ${money(c.warm)}` : 'next message: normal cost'
  const nextCold = dollars ? `next message ≈ ${money(c.cold)}${more}` : `next message: ${ratio ? `${ratio}× more` : r ? 'normal cost' : 'much more'}`
  // what a new chat would not pay: the rebuild beyond a fresh chat's own first prompt.
  // no price known: fall back to size (≈ $0.50 of Opus 5.5 rebuild)
  const fresh = freshStart(s)
  const beyond = Math.max(0, rec.prefix - fresh)
  const isBigRebuild = c ? (rec.prefix > 0 ? (c.cold * beyond) / rec.prefix : 0) >= s.rebuildLimitUsd : beyond >= 60_000

  if (left <= 0 || rec.resetBy) {
    const head = `${rec.resetBy ? RESET_LABEL[rec.resetBy] : 'cache expired'} · ${nextCold}${ctx}`
    const save = handoffSaving(rec.prefix, c?.cold ?? 0, { ...HAIKU_ESTIMATE, usd: summaryUsd(s.handoffModel, HAIKU_ESTIMATE.in, HAIKU_ESTIMATE.out) ?? 0 }, fresh)
    // nothing to show as saved (a rebuild barely above the limit): the plain suggestion
    const suggest = save.isWorth ? `🔄 Try ${HANDOFF} to save ${tokens(save.tokens)} tokens${dollars ? ` | ${money(save.usd)}` : ''}` : SUGGEST_NEW
    return isBigRebuild
      ? { light: 'red', text: `🔴 ${head} · ${suggest}`, shouldPopup: !rec.warned && !rec.resetBy }
      : { light: 'orange', text: `🟠 ${head} · ${save.isWorth ? 'Rebuild under your limit' : 'Small rebuild (a new chat costs about as much)'}, fine to keep going`, shouldPopup: false }
  }
  // yellow only on the 1h cache: a 5m window is too short for a useful warning
  if (rec.ttlMin >= 60 && left <= s.warnMinutes * 60_000) {
    const later = dollars ? `, later ≈ ${money(c.cold)}${more}` : `, later ${ratio ? `${ratio}× more` : r ? 'normal cost' : 'much more'}`
    return { light: 'yellow', text: `🟡 ${clock(left)} min left · ${nextWarm}${later}${ctx} · ⏳ Reply soon or try ${HANDOFF}`, shouldPopup: false }
  }
  const head = `🟢 ${clock(left)} min left · ${nextWarm}${ctx}`
  if (rec.prefix >= s.longChatTokens) {
    return { light: 'green', text: `${head} · ${SUGGEST_NEW}`, shouldPopup: false }
  }
  return { light: 'green', text: `${head} · ✅ Keep going`, shouldPopup: false }
}

// Shown before this chat's first reply, when there is nothing to measure yet.
export const WAITING = '⚪️ cache-monitor will start after you send a message'

// The heads-up when you send into a red chat; the cause decides the wording.
export function sendWarning(rec: Rec): string {
  const why = rec.resetBy === 'model' ? 'the model changed' : rec.resetBy === 'compact' ? 'the chat was compacted' : "this chat's cache had expired"
  return `Heads-up: ${why}, so this message rebuilds the cache. See the bar for the cost.`
}

// Fills in a record for a chat this plugin never saw reply (older chats), from
// what Claude Code says at session start. Nothing is learned from it (read/write 0).
// `likelyExpired` is Claude Code's own judgment (it knows the chat's TTL): it corrects the
// lifetime (expired within the hour: a 5-minute chat; alive past 5 minutes: a 1-hour one).
export function fromSessionStart(
  i: { secondsSince: number; contextTokens: number; model: string; window?: number; likelyExpired?: boolean },
  now: number, prev: Rec | null, s: Settings,
): Rec {
  let ttlMin = prev?.ttlMin ?? ttlFor(s.memoryMinutes)
  const ago = i.secondsSince * 1000
  if (s.memoryMinutes === 'auto' && i.likelyExpired === true && ago < ttlMin * 60_000) ttlMin = 5
  if (s.memoryMinutes === 'auto' && i.likelyExpired === false && ago > 5 * 60_000) ttlMin = 60
  // the engine says expired though the time says not (a reset): show it expired
  const at = i.likelyExpired === true ? Math.min(now - ago, now - ttlMin * 60_000) : now - ago
  return {
    at, prefix: i.contextTokens, out: 0, model: i.model, read: 0, write: 0,
    ttlMin, miss5: 0, warned: false, window: i.window ?? prev?.window, isEstimate: true,
  }
}

// A model name as typed (option or /cache-monitor-handoff argument): an alias or id, nothing else.
export const validModel = (v: unknown): string | undefined =>
  typeof v === 'string' && /^[\w.:@\[\]-]{1,100}$/.test(v.trim()) ? v.trim() : undefined

export function readSettings(o: Record<string, unknown>): Settings {
  const num = (v: unknown, d: number) => (typeof v === 'number' && v > 0 ? v : typeof v === 'string' && Number(v) > 0 ? Number(v) : d)
  return {
    rebuildLimitUsd: num(o.rebuildLimitUsd, DEFAULTS.rebuildLimitUsd),
    warnMinutes: num(o.warnMinutes, DEFAULTS.warnMinutes),
    longChatTokens: num(o.longChatTokens, DEFAULTS.longChatTokens),
    costStyle: o.costStyle === 'times' ? 'times' : 'dollars',
    memoryMinutes: o.memoryMinutes === '5' || o.memoryMinutes === '60' ? o.memoryMinutes : 'auto',
    // "custom" in the picker: the free-text field holds the model
    handoffModel: (o.handoffModel === 'custom' ? validModel(o.handoffModelCustom) : validModel(o.handoffModel)) ?? DEFAULTS.handoffModel,
    freshChatTokens: num(o.freshChatTokens, 0),
  }
}

// /cache-monitor-stats: counters per chat (`st:<chat id>`) and for all chats (`st:all`). Counts only, never chat text.
export type Stats = {
  since: number // ms epoch of the first count
  replies: number
  read: number // cache read tokens
  write: number // cache write tokens
  input: number // uncached input tokens
  rebuilds: number // replies sent after the cache expired or was reset
  rebuildTokens: number
  rebuildUsd: number
  handoffs: number
  savedTokens: number // a handoff's estimated saving, counted once its new chat is used (once per handoff file)
  savedUsd: number
  chats?: number // all chats only
  isFilled?: boolean // this chat's history was read from its transcript (or never needs reading)
  partialSince?: number // transcript too big to read: counted from this time only
  retired?: boolean // pruned after 90 days: its counts live on in st:retired, it counts as a chat there
  first?: { total: number; read: number } // this chat's first request: what a fresh chat costs (freshStart)
  folded?: Record<string, number> // st:retired only: `<key>@<at>` of every chat generation already folded in
}

const COUNTS = ['replies', 'read', 'write', 'input', 'rebuilds', 'rebuildTokens', 'rebuildUsd', 'handoffs', 'savedTokens', 'savedUsd', 'chats'] as const

export const emptyStats = (now: number): Stats => ({ since: now, replies: 0, read: 0, write: 0, input: 0, rebuilds: 0, rebuildTokens: 0, rebuildUsd: 0, handoffs: 0, savedTokens: 0, savedUsd: 0 })

// Adds `d` to `s`; an unreadable stored value counts as empty, never NaN.
export function addStats(s: unknown, d: Partial<Stats>, now: number): Stats {
  const base = { ...emptyStats(now), ...(s && typeof s === 'object' ? (s as Partial<Stats>) : {}) }
  const out: Stats = { ...base }
  for (const k of COUNTS) {
    const v = d[k]
    if (typeof v !== 'number') continue
    const cur = Number(base[k] ?? 0)
    out[k] = (Number.isFinite(cur) ? cur : 0) + v
  }
  if (!Number.isFinite(out.since)) out.since = now
  if (!out.first && d.first) out.first = d.first
  return out
}

// A record still holding counts of its own (a tombstone holds none until its chat is resumed).
export const hasCounts = (s: Partial<Stats>) => COUNTS.some(k => k !== 'chats' && Number(s[k] ?? 0) !== 0)

// The /cache-monitor-stats reply: this chat and all chats side by side.
export function statsText(chat: Stats, all: Stats, s: Settings): string {
  const usd = (n: number) => (n !== 0 ? money(n) : '$0.00')
  const local = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
  const hit = (x: Stats) => {
    const total = x.read + x.write + x.input
    return total ? `${Math.round((x.read / total) * 100)}%` : '–'
  }
  const dollars = s.costStyle === 'dollars'
  const rebuilds = (x: Stats) => `${x.rebuilds}${x.rebuilds ? ` (${tokens(x.rebuildTokens)} tokens${dollars ? `, ${usd(x.rebuildUsd)}` : ''})` : ''}`
  const rows: [string, (x: Stats) => string, boolean?][] = [
    ['Saved by handoffs (est.)', x => usd(x.savedUsd), dollars],
    ['Tokens saved (est.)', x => (x.savedTokens < 0 ? `-${tokens(-x.savedTokens)}` : tokens(x.savedTokens))],
    ['Cache hit rate', hit],
    ['Handoffs', x => String(x.handoffs)],
    ['Cold rebuilds paid', rebuilds],
    ['Replies', x => String(x.replies)],
  ]
  const lines = rows.filter(([, , show]) => show !== false).map(([name, f]) => `| ${name} | ${f(chat)} | ${f(all)} |`)
  return [
    'cache-monitor stats',
    '',
    `| | This chat${chat.partialSince ? ` (since ${local(chat.partialSince)})` : ''} | All chats |`,
    '|---|---|---|',
    ...lines,
    `| Chats | – | ${all.chats ?? 0} |`,
  ].join('\n')
}

// "183K" / "1.2M" / "850" back to a number (the handoff notice's rounded figures).
const untokens = (t: string) => Number.parseFloat(t) * (t.endsWith('M') ? 1e6 : t.endsWith('K') ? 1e3 : 1)

type Usage = Record<string, unknown> & { cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number }; speed?: string }

// A chat's history from its transcript (JSONL), for chats this plugin never counted live.
// Each request is written once per content block: counted once per message id. A rebuild is a
// request more than the cache time after the one before (the time each write used, from
// usage.cache_creation), or one that read far less than the chat held (isSilentReset: a model
// switch, a compaction, fast mode...). Handoffs come from this plugin's notice rows (a system row,
// or the command's output row), never from text that merely quotes one; only notices of versions
// before 0.6.0 ("You saved approx") carry a saving, since later ones count it when the new chat is used.
export function statsFromTranscript(jsonl: string, ttlMin: number, setting: Settings['memoryMinutes'] = 'auto'): Partial<Stats> {
  const out = { replies: 0, read: 0, write: 0, input: 0, rebuilds: 0, rebuildTokens: 0, rebuildUsd: 0, handoffs: 0, savedTokens: 0, savedUsd: 0 }
  let first: Stats['first']
  const seen = new Set<string>()
  let prev: { at: number; ttl: number; prefix: number; out: number } | null = null
  for (const line of jsonl.split('\n')) {
    if (!line.includes('"usage"') && !line.includes('Handoff saved to')) continue
    let d: { type?: string; isSidechain?: boolean; timestamp?: string; content?: unknown; message?: { id?: string; model?: string; usage?: Usage } }
    try { d = JSON.parse(line) } catch { continue }
    if (d.type === 'system' && typeof d.content === 'string' && /^(?:<local-command-stdout>)?(?:[\w+.-]+: )?Handoff saved to /.test(d.content)) {
      out.handoffs++
      const m = /You saved approx (\d+(?:\.\d+)?[KM]?) tokens and (<)?\$(\d+(?:\.\d+)?)/.exec(d.content)
      if (m) { out.savedTokens += untokens(m[1]!); out.savedUsd += m[2] ? 0 : Number(m[3]) }
      continue
    }
    const u = d.message?.usage
    if (d.type !== 'assistant' || d.isSidechain || !u || !d.message?.model || d.message.model.startsWith('<')) continue
    const id = d.message.id ?? `${d.timestamp}`
    if (seen.has(id)) continue
    seen.add(id)
    const at = Date.parse(d.timestamp ?? '')
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
    const read = num(u.cache_read_input_tokens), write = num(u.cache_creation_input_tokens), input = num(u.input_tokens), output = num(u.output_tokens)
    const ttl = learnTtl(setting, u.cache_creation ?? {}, prev?.ttl ?? ttlMin)
    if (!first) first = { total: input + read + write, read }
    out.replies++
    out.read += read
    out.write += write
    out.input += input
    const usage = { cache_read_input_tokens: read, cache_creation_input_tokens: write }
    // a row's timestamp is its reply's end, so a time gap also holds the reply's own length: a
    // rebuild is told by what the request read (far less than the chat held), not by the clock
    if (prev && isSilentReset(prev, usage)) {
      const p = priceOf(d.message.model, input + read + write, u.speed === 'fast')
      out.rebuilds++
      out.rebuildTokens += write
      out.rebuildUsd += p ? (write * writeRate(p.input, ttl)) / 1e6 : 0
    }
    prev = { at: Number.isFinite(at) ? at : prev?.at ?? 0, ttl, prefix: input + read + write + output, out: output }
  }
  return first ? { ...out, first } : out
}

// All chats, worked out when asked: every chat's own counts plus the pruned ones' (st:retired).
// Chats = chats with a reply, plus the retired ones (a resumed retired chat isn't counted twice).
// A chat whose counts st:retired already folded in (its tombstone write failed) is skipped.
export function sumStats(chats: [key: string, value: unknown][], retired: unknown, now: number): Stats {
  const folded = (retired as Stats | undefined)?.folded ?? {}
  let all = addStats(retired, {}, now)
  delete all.folded
  for (const [k, c] of chats) {
    const at = (c as { at?: unknown } | null)?.at
    if (folded[`${k}@${at}`] !== undefined) continue // a tombstone holds no counts: skipping it is harmless
    const x = addStats(c, {}, now)
    all = addStats(all, { ...x, chats: x.replies > 0 && !(c as Stats).retired ? 1 : 0 }, now)
    if (x.since < all.since) all.since = x.since
  }
  delete all.first
  return all
}

// The dev copy (built by scripts/dev-sync.sh as cache-monitor-dev) never updates the real install.
// endsWith: dev-sync.sh renames every quoted 'cache-monitor', so an equality check would flip.
export const isDevCopy = (name: string) => name.endsWith('-dev')

// /cache-monitor-update: "0.10.0" is newer than "0.9.3".
export function newerVersion(a: string, b: string): boolean {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false
    if (x !== y) return x > y
  }
  return false
}

// A downloaded prices.json, checked before it can change any figure: shape, sane amounts,
// at most 200 models, and never older than the bundled table.
// `now` given: a date more than 7 days ahead is refused (a typo would outrank every later release).
export function validatePrices(json: unknown, bundledDate: string, now?: number): { sourceDate: string; prices: Record<string, [number, number]> } | { error: string } {
  const j = json as { sourceDate?: unknown; prices?: unknown } | null
  if (!j || typeof j !== 'object' || typeof j.sourceDate !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(j.sourceDate)) return { error: 'no valid sourceDate' }
  if (j.sourceDate < bundledDate) return { error: `older than the bundled prices (${j.sourceDate} < ${bundledDate})` }
  if (now !== undefined && j.sourceDate > new Date(now + 7 * 24 * 3600_000).toISOString().slice(0, 10)) return { error: `dated in the future (${j.sourceDate})` }
  if (!j.prices || typeof j.prices !== 'object' || Array.isArray(j.prices)) return { error: 'no prices table' }
  const entries = Object.entries(j.prices as Record<string, unknown>)
  if (!entries.length || entries.length > 200) return { error: `${entries.length} models (1 to 200 expected)` }
  const prices: Record<string, [number, number]> = {}
  for (const [k, v] of entries) {
    if (!/^[a-z]+-\d+(?:-\d{1,2})?$/.test(k)) return { error: `bad model key ${JSON.stringify(k).slice(0, 40)}` }
    if (!Array.isArray(v) || v.length !== 2) return { error: `bad entry for ${k}` }
    const [input, read] = v as [unknown, unknown]
    if (typeof input !== 'number' || typeof read !== 'number' || !(input > 0 && input <= 100) || !(read > 0 && read <= input)) return { error: `bad price for ${k}` }
    prices[k] = [input, read]
  }
  return { sourceDate: j.sourceDate, prices }
}
