// End-to-end tests through the real hooks: a reply, a model switch, a compact, an
// older chat, /clear, an app restart. Each draws the bar on every surface and expects
// the SAME text, so a change made for VS Code or the terminal can't silently break desktop.
import { expect, mock, test } from 'claude-code/testing'

import { PRICES_DATE } from '../hooks/logic'

const SURFACES = ['desktop', 'vscode', 'terminal'] as const
const MIN = 60_000
const T0 = 1_800_000_000_000
const HIDDEN = '(engine)' // what Claude Code draws when the plugin shows nothing
const WAITING = '⚪️ cache-monitor will start after you send a message'
const BAR = { plugin: 'cache-monitor', component: 'AbovePrompt', props: { hasSurvey: false, isCollapsed: false, isWorking: false } as never } as const // the kit fills the rest of the band's props

type Body = Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>
type On = Parameters<Body>[1]
type Dollar = Parameters<Body>[0]
// e5m / e1h: the write's 5-minute / 1-hour split; left out, a subscription's 1h write. noSplit: a provider that reports none
type Usage = { read: number; write: number; out?: number; model?: string; input?: number; e5m?: number; e1h?: number; noSplit?: boolean }

// The engine beneath the plugin (one chat, Opus 5.5, 1M window). Every stand-in is
// registered here, before the test's first call on $, as the kit requires.
// map: a store the test can look into afterwards (instead of mock.store)
function engine(on: On, opts: { store?: Record<string, unknown>; state?: unknown; streamMs?: number; brokenStore?: boolean; now?: number; contextTokens?: number; map?: Map<string, unknown> } = {}) {
  const clock = mock.clock(on, { now: opts.now ?? T0 })
  if (opts.brokenStore) for (const k of ['store.get', 'store.set', 'store.delete', 'store.keys'] as const) on(k, () => { throw new Error('store broken') })
  else if (opts.map) {
    const m = opts.map
    for (const [k, v] of Object.entries(opts.store ?? {})) m.set(k, v)
    on('store.get', (_, e) => ({ value: m.get((e as { key: string }).key) }) as never)
    on('store.set', (_, e) => { const x = e as { key: string; value: unknown }; m.set(x.key, JSON.parse(JSON.stringify(x.value))); return { value: undefined } as never })
    on('store.delete', (_, e) => { m.delete((e as { key: string }).key); return { value: undefined } as never })
    on('store.keys', () => ({ value: [...m.keys()] }) as never)
  } else mock.store(on, opts.store)
  const toasts: string[] = []
  let usage: Usage = { read: 0, write: 0 }
  const steps = { n: 0 } // main-model requests the engine saw
  const session = { id: 'chat-1' } // a test moves to another chat by setting it
  on('session.id', () => ({ value: session.id }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: T0, context: { window: 1_000_000, ...(opts.contextTokens !== undefined ? { tokens: opts.contextTokens } : {}) } } }) as never)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('classic.SessionStart', () => ({}))
  on('classic.PostModelSwitch', () => ({}))
  on('classic.PostCompact', () => ({}))
  const commands: string[] = []
  on('command.register', (_, e) => { commands.push((e as { name: string }).name); return { value: { command: 'cache-monitor' } } as never })
  on('ui.toast', (_, e) => { toasts.push(JSON.stringify(e)); return { value: undefined } })
  on('ui.render', ($, e) => { const { Text } = $.ui.resolve(e); return <Text>{HIDDEN}</Text> })
  if (opts.state !== undefined) on('state.get', () => ({ value: { value: opts.state, version: 1 } }))
  on('turn.step', async function* () {
    steps.n++
    if (opts.streamMs) await clock.advance(opts.streamMs)
    return {
      turnId: 't', index: 0, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: {
        input_tokens: usage.input ?? 0, output_tokens: usage.out ?? 0, cache_read_input_tokens: usage.read, cache_creation_input_tokens: usage.write, model: usage.model ?? 'claude-opus-5-5',
        ...(usage.noSplit || !usage.write ? {} : { ephemeral_5m_input_tokens: usage.e5m ?? 0, ephemeral_1h_input_tokens: usage.e1h ?? (usage.e5m === undefined ? usage.write : 0) }),
      },
    }
  })
  return {
    clock,
    toasts,
    commands,
    steps,
    session,
    async reply($: Dollar, u: Usage, agentId?: string) {
      usage = u
      const s = $.turn.step({ turnId: 't', index: 0, model: u.model ?? 'claude-opus-5-5', messageCount: 2, ...(agentId ? { agentId } : {}) })
      for await (const _ of s) { /* drain */ }
    },
  }
}

async function bars($: Dollar) {
  const out: (string | null)[] = []
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAR, surface })
    out.push((await ui.find({ type: 'Text' }))?.text ?? null)
    await ui.unmount()
  }
  return out
}

async function expectBar($: Dollar, text: string) {
  expect(await bars($)).toEqual(SURFACES.map(() => text))
}

async function start($: Dollar, surface: (typeof SURFACES)[number] = 'desktop') {
  await $.session.start({ cwd: '/', surface, isInteractive: true })
}

test('no reply yet: the waiting line on every surface', async ($, on) => {
  engine(on)
  await start($)
  await expectBar($, WAITING)
})

test('after a reply: green with the countdown, identical on desktop, vscode, terminal', async ($, on) => {
  const w = engine(on)
  await start($)
  await w.reply($, { read: 45_000, write: 5_000 })
  await w.clock.advance(10 * MIN)
  await expectBar($, '🟢 50:00 min left · next message ≈ $0.01 · 50K / 1M · ✅ Keep going')
})

test('countdown starts at the request, not the end of a 3-minute reply', async ($, on) => {
  const w = engine(on, { streamMs: 3 * MIN })
  await start($)
  await w.reply($, { read: 50_000, write: 0 })
  await expectBar($, '🟢 57:00 min left · next message ≈ $0.01 · 50K / 1M · ✅ Keep going')
})

test('subagent steps do not move the clock', async ($, on) => {
  const w = engine(on)
  await start($)
  await w.reply($, { read: 50_000, write: 0 })
  await w.clock.advance(30 * MIN)
  await w.reply($, { read: 900_000, write: 0 }, 'agent-7')
  await expectBar($, '🟢 30:00 min left · next message ≈ $0.01 · 50K / 1M · ✅ Keep going')
})

test('ticks to yellow, then red, with exactly one pop-up', async ($, on) => {
  const w = engine(on)
  await start($)
  await w.reply($, { read: 228_000, write: 0 })
  await w.clock.advance(57 * MIN)
  await expectBar($, '🟡 3:00 min left · next message ≈ $0.05, later ≈ $1.82 (40× more) · 228K / 1M · ⏳ Reply soon or try /cache-monitor-handoff')
  await w.clock.advance(15 * MIN)
  await expectBar($, '🔴 cache expired · next message ≈ $1.82 (40× more) · 228K / 1M · 🔄 Try /cache-monitor-handoff to save 144K tokens | $1.51')
  await w.clock.advance(5 * MIN)
  // the pop-up says exactly what the bar says
  expect(w.toasts.filter(t => t.includes('🔴 cache expired · next message ≈ $1.82 (40× more) · 228K / 1M · 🔄 Try /cache-monitor-handoff to save 144K tokens | $1.51')).length).toBe(1)
})

test('model switch re-prices at once; a resume "switch" does not', async ($, on) => {
  const w = engine(on)
  await start($)
  await w.reply($, { read: 228_000, write: 0 })
  const sw = { requested_model: null, context_tokens: 228_000, prompt_cache_warm: true, cache_ttl: '1h', estimated_cache_write_usd: 1, pricing: 'catalog' }
  await $.classic.PostModelSwitch({ ...sw, from_model: 'claude-sonnet-5-5', to_model: 'claude-opus-5-5', source: 'resume' } as never)
  expect((await bars($))[0]?.startsWith('🟢')).toBe(true)
  await $.classic.PostModelSwitch({ ...sw, from_model: 'claude-opus-5-5', to_model: 'claude-sonnet-5-5', source: 'command' } as never)
  await expectBar($, '🔴 cache reset (model changed) · next message ≈ $0.91 (40× more) · 228K / 1M · 🔄 Try /cache-monitor-handoff to save 144K tokens | $0.75')
})

// Seen live 2026-11-16: /model switches then /compact left the next reply's countdown at 5:00.
test('after model switches and a compact, the next reply counts down from a full hour', async ($, on) => {
  const w = engine(on)
  await start($)
  await w.reply($, { read: 228_000, write: 0 })
  const sw = { requested_model: 'haiku', context_tokens: 228_000, prompt_cache_warm: true, cache_ttl: '5m', estimated_cache_write_usd: 1, pricing: 'catalog', source: 'command' }
  await $.classic.PostModelSwitch({ ...sw, from_model: 'claude-opus-5-5', to_model: 'claude-haiku-5-5' } as never)
  await $.classic.PostModelSwitch({ ...sw, from_model: 'claude-haiku-5-5', to_model: 'claude-opus-5-5' } as never)
  await $.classic.PostCompact({ trigger: 'manual', compact_summary: 'x'.repeat(40_000) } as never)
  await w.clock.advance(20 * MIN)
  await $.classic.SessionStart({ source: 'compact', session_id: 'chat-1', seconds_since_last_response: 1200, context_tokens: 30_000, prompt_cache_likely_expired: true, model: 'claude-opus-5-5' } as never)
  await w.reply($, { read: 0, write: 30_000 })
  await expectBar($, '🟢 60:00 min left · next message ≈ <$0.01 · 30K / 1M · ✅ Keep going')
})

test('compact resets the cache at once', async ($, on) => {
  const w = engine(on)
  await start($)
  await w.reply($, { read: 228_000, write: 0 })
  await $.classic.PostCompact({ trigger: 'manual', compact_summary: 'x'.repeat(40_000) } as never)
  await expectBar($, '🟠 cache reset (chat compacted) · next message ≈ $0.08 (14× more) · 30K / 1M · Small rebuild (a new chat costs about as much), fine to keep going')
})

test('older chat: filled in on resume, no reply needed', async ($, on) => {
  engine(on)
  await start($)
  await $.classic.SessionStart({ source: 'resume', session_id: 'chat-1', seconds_since_last_response: 7200, context_tokens: 290_000, prompt_cache_likely_expired: true, model: 'claude-opus-5-5' } as never)
  await expectBar($, '🔴 cache expired · next message ≈ $2.32 (40× more) · 290K / 1M · 🔄 Try /cache-monitor-handoff to save 206K tokens | $2.00')
})

test('/clear goes back to the waiting line', async ($, on) => {
  const w = engine(on)
  await start($)
  await w.reply($, { read: 50_000, write: 0 })
  await $.session.end({ reason: 'clear', sessionId: 'chat-1', resume: {} } as never)
  await expectBar($, WAITING)
})

test('app restart: the saved record brings the bar back before any reply', async ($, on) => {
  const saved = { at: T0 - 10 * MIN, prefix: 50_000, out: 0, model: 'claude-opus-5-5', read: 50_000, write: 0, ttlMin: 60, miss5: 0, warned: false, window: 1_000_000 }
  engine(on, { store: { 'cmx:chat-1': saved } })
  await start($)
  await expectBar($, '🟢 50:00 min left · next message ≈ $0.01 · 50K / 1M · ✅ Keep going')
})

test('a malformed record from an older version is ignored, never NaN', async ($, on) => {
  engine(on, { store: { 'cmx:chat-1': { at: 'x' } }, state: { at: 1, prefix: 5 } })
  await start($)
  const out = await bars($)
  expect(out.some(t => t?.includes('NaN'))).toBe(false)
})

test('the close button hides the bar on every surface; /cache-monitor brings it back', async ($, on) => {
  const w = engine(on)
  await start($)
  await w.reply($, { read: 50_000, write: 0 })
  const ui = await $.ui.mount({ ...BAR, surface: 'desktop' })
  await ui.press({ key: 'close' })
  await ui.unmount()
  await expectBar($, HIDDEN)
  await $.command.run({ command: 'cache-monitor', args: '' } as never)
  expect((await bars($))[0]?.startsWith('🟢')).toBe(true)
})

// VS Code's own case: its ✕ is pressed inside the extension's webview, a different
// drawing from desktop's, so press it there too.
test('vscode: the ✕ sits beside the text, and pressing it hides the bar everywhere', async ($, on) => {
  const w = engine(on)
  await start($)
  await w.reply($, { read: 50_000, write: 0 })
  const ui = await $.ui.mount({ ...BAR, surface: 'vscode' })
  expect((await ui.find({ type: 'Button', key: 'close' }))?.text).toBe('✕')
  await ui.press({ key: 'close' })
  await ui.unmount()
  await expectBar($, HIDDEN)
  await $.command.run({ command: 'cache-monitor', args: '' } as never)
  expect((await bars($)).every(t => t?.startsWith('🟢'))).toBe(true)
})

// VS Code's webview wrapped the ✕ below the text (seen 2026-11-16). The kit can't measure
// layout, so pin the props that keep it top-right.
test('vscode: the ✕ row never wraps and the text column can shrink', async ($, on) => {
  const w = engine(on)
  await start($)
  await w.reply($, { read: 50_000, write: 0 })
  const ui = await $.ui.mount({ ...BAR, surface: 'vscode' })
  expect((await ui.find({ type: 'Box', key: 'row' }))?.props).toMatchObject({ flexDirection: 'row', flexWrap: 'nowrap' })
  expect((await ui.find({ type: 'Box', key: 'text' }))?.props).toMatchObject({ flexShrink: 1, minWidth: 0 })
  await ui.unmount()
})

test('a closed bar also stops the pop-up', async ($, on) => {
  const w = engine(on)
  await start($)
  await w.reply($, { read: 228_000, write: 0 })
  const ui = await $.ui.mount({ ...BAR, surface: 'desktop' })
  await ui.press({ key: 'close' })
  await ui.unmount()
  await w.clock.advance(80 * MIN)
  expect(w.toasts.length).toBe(0)
})

// --- /cache-monitor-handoff -------------------------------------------------------------
// Everything outside the plugin is a stand-in: the chat, Haiku, the disk, /clear, the box.
const BRIEF = '## Handoff Confidence\nHigh: all there.\n\n## Last Request from the User\nship it\nStatus: Answered\n\n## Next Steps\n1. Release.'

function handoffEngine(on: On, opts: { reply?: string | null; clearRefusals?: number; fillRefused?: boolean; noticeRefused?: boolean; surface?: (typeof SURFACES)[number] } = {}) {
  const w = engine(on)
  const calls = { model: [] as { model: string; system?: unknown; prompt: unknown; effort?: string; maxTokens?: number }[], writes: [] as { path: string; text: string }[], clears: 0, fills: [] as string[], copies: [] as string[], notices: [] as string[] }
  // the kit has no disk: the skill file's three parts, with real section names
  on('fs.read', (_, e) => {
    if (!String((e as { path: string }).path).replace(/\\/g, '/').endsWith('/hooks/handoff-skill.md')) throw new Error('unexpected read')
    return { value: '# Final brief\nRole.\n\n## Handoff Confidence\nx\n\n## Last Request from the User\nx\n\n## What Was Tried and Why It Failed\nx\n\n## Next Steps\nx\n\n# Closing line\nWrite it now.\n\n# Next-chat instructions\n## Instructions\nGo.' }
  })
  on('session.messages', () => ({ value: [
    { role: 'user', text: 'ship it', toolUses: [] },
    { role: 'assistant', text: 'done', toolUses: [{ tool_use_id: 'a', tool: 'Edit', input: { file_path: 'hooks/register.tsx' }, text: 'ok' }] },
  ] }))
  on('session.cwd', () => ({ value: '/Users/x/proj' }))
  on('session.surfaces', () => ({ value: [opts.surface ?? 'terminal'] }) as never)
  on('session.append', (_, e, next) => {
    const m = (e as unknown as { message: { type: string; content: { text: string }[] } }).message
    if (opts.noticeRefused) return { deny: 'no' } as never
    if (m.type === 'system') calls.notices.push(m.content[0]!.text)
    return next(e)
  })
  on('ui.log', () => ({ value: undefined }))
  on('model.complete', (_, e) => {
    calls.model.push(e as never)
    return { value: opts.reply === null
      ? { isAnswered: false, reason: 'api-error', text: '' }
      : { isAnswered: true, text: opts.reply ?? BRIEF, usage: { input_tokens: 40_000, output_tokens: 1_500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } } as never
  })
  on('fs.write', (_, e) => { const w = e as { path: string; text: string }; calls.writes.push({ ...w, path: String(w.path).replace(/\\/g, '/') }); return { value: undefined } })
  on('command.run', { command: 'clear' }, () => { calls.clears++; if (calls.clears <= (opts.clearRefusals ?? 0)) throw new Error("busy"); return { text: '' } })
  on('prompt.fill', (_, e) => { calls.fills.push((e as { text: string }).text); return { isFilled: !opts.fillRefused } as never })
  on('ui.copy', (_, e) => { calls.copies.push((e as { text: string }).text); return { value: { isCopied: true } } })
  return { ...w, calls }
}

async function handoff($: Dollar, args = '') {
  return $.command.run({ command: 'cache-monitor-handoff', args } as never)
}

test('handoff: Haiku writes it from the chat read locally; the main model never runs', async ($, on) => {
  const h = handoffEngine(on)
  await start($, 'terminal')
  const r = await handoff($)
  expect(h.steps.n).toBe(0)
  expect(h.calls.model.length).toBe(1)
  expect(h.calls.model[0]).toMatchObject({ model: 'haiku', effort: 'high', maxTokens: 64_000 }) // no cap yet: the API's ceiling
  expect(h.calls.model[0]).toMatchObject({ timeoutMs: 180_000 }) // your call: 3 minutes, then facts only
  expect(String(h.calls.model[0]!.system)).toContain('## What Was Tried and Why It Failed') // the real skill file
  expect(String(h.calls.model[0]!.prompt)).toContain('# Extracted Facts')
  expect(h.calls.writes.length).toBe(2) // the brief, then the folder's .gitignore
  expect(h.calls.writes[0]!.path).toMatch(/\/\.claude\/handoffs\/\d{4}-\d\d-\d\d-\d{6}-chat-1\.md$/)
  expect(h.calls.writes[0]!.text).toContain('## Handoff Confidence')
  expect(h.calls.writes[0]!.text).toContain('- hooks/register.tsx')
  // the line is a notice kept in the old chat, not command output that goes unseen after the clear
  expect(r.text).toBe(undefined)
  expect(h.calls.notices.length).toBe(1)
  expect(h.calls.notices[0]).toMatch(/^Handoff saved to \.claude\/handoffs\/.+\. This command never resent the chat to the main model: no cache read, no rebuild\.$/)
})

test('handoff: it clears to a fresh chat and puts the line in its box, unsent', async ($, on) => {
  const h = handoffEngine(on)
  await start($, 'terminal')
  await handoff($)
  await h.clock.advance(1) // /clear starts on a timer once the command has returned
  await w8()
  expect(h.calls.copies).toEqual([])
  expect(h.calls.clears).toBe(1)
  await $.classic.SessionStart({ source: 'clear', session_id: 'chat-2', model: 'claude-opus-5-5' } as never)
  await w8()
  expect(h.calls.fills.length).toBe(1)
  expect(h.calls.fills[0]).toMatch(/^Read \/Users\/x\/proj\/\.claude\/handoffs\/.+-chat-1\.md and continue from where we left off\.$/)
  await expectBar($, WAITING)
})

// Seen live at 23:31 in VS Code: /clear refused right after the command, the session still busy.
test('handoff: /clear refused at first is retried, and the fresh chat still opens', async ($, on) => {
  const h = handoffEngine(on, { clearRefusals: 2 })
  await start($, 'terminal')
  await handoff($)
  await settle(h)
  expect(h.calls.clears).toBe(3)
  expect(h.calls.copies).toEqual([])
  await $.classic.SessionStart({ source: 'clear', session_id: 'chat-2', model: 'claude-opus-5-5' } as never)
  await w8()
  expect(h.calls.fills.length).toBe(1)
})

test('handoff: /clear refused every time → the line goes to the clipboard and nothing is cleared', async ($, on) => {
  const h = handoffEngine(on, { clearRefusals: 99 })
  await start($, 'terminal')
  await handoff($)
  await settle(h)
  expect(h.calls.clears).toBe(4)
  expect(h.calls.copies.length).toBe(1)
  expect(h.calls.fills.length).toBe(0)
})

// runs out the clear retries (0, 0.5, 1.5, 3 s) on the test clock
async function settle(h: { clock: { advance: (ms: number) => Promise<unknown> } }) {
  for (const ms of [1, 500, 1_500, 3_000, 1]) {
    await h.clock.advance(ms)
    await w8()
  }
}

test('handoff: Haiku returns a failure → like a thrown one: nothing cleared or counted, the facts kept', async ($, on) => {
  const h = handoffEngine(on, { reply: null })
  await start($, 'terminal')
  const r = await handoff($)
  await settle(h)
  expect(h.calls.clears).toBe(0)
  expect(h.calls.fills.length).toBe(0)
  expect(h.calls.notices.length).toBe(0)
  expect(h.calls.writes[0]!.text).toContain('Haiku did not return a usable brief')
  expect(h.calls.writes[0]!.text).toContain('## Last Real User Message (verbatim)\nship it')
  expect(r.text).toMatch(/^cache-monitor: no handoff \(Haiku api-error\)\. This chat is untouched\. The facts extracted in code are in \.claude\/handoffs\/.+\.md, if you want them\.$/)
  expect(await stats($)).toContain('| Handoffs | 0 | 0 |')
})

test('handoff: a reply with no sections is not used as a brief, and nothing is cleared', async ($, on) => {
  const h = handoffEngine(on, { reply: 'Sure! Here is a summary of the chat.' })
  await start($, 'terminal')
  const r = await handoff($)
  await settle(h)
  expect(h.calls.clears).toBe(0)
  expect(h.calls.writes[0]!.text.includes('Sure!')).toBe(false)
  // the reason, with Haiku's counts: out at the cap would mean it ran out of room
  expect(r.text).toContain(`(Haiku's reply lacked "Last Request from the User" or "Next Steps", in 40000 / out 1500 of 64000 tokens)`)
})

test('handoff: a stub reply with only a confidence line is no brief: the chat stays', async ($, on) => {
  const h = handoffEngine(on, { reply: '## Handoff Confidence\nHigh' })
  await start($, 'terminal')
  const r = await handoff($)
  await settle(h)
  expect(h.calls.clears).toBe(0)
  expect(r.text).toContain('This chat is untouched')
})

test('handoff: the user\'s last message is in the file even when the brief quotes it', async ($, on) => {
  const h = handoffEngine(on)
  await start($, 'terminal')
  await handoff($)
  expect(h.calls.writes[0]!.text).toContain('## Next Steps\n1. Release.')
  expect(h.calls.writes[0]!.text).toContain('## Last Real User Message (verbatim)\nship it')
})

// lets fire-and-forget promises (fill, copy) settle
// the kit runs on a real event loop: let queued work settle
const w8 = () => new Promise(r => (globalThis as unknown as { setTimeout: (f: (v: unknown) => void, ms: number) => void }).setTimeout(r, 20))

test('handoff: the box refuses the line → it goes to the clipboard', async ($, on) => {
  const h = handoffEngine(on, { fillRefused: true })
  await start($, 'terminal')
  await handoff($)
  await h.clock.advance(1)
  await w8()
  await $.classic.SessionStart({ source: 'clear', session_id: 'chat-2', model: 'claude-opus-5-5' } as never)
  await w8()
  expect(h.calls.fills.length).toBe(1)
  expect(h.calls.copies).toEqual(h.calls.fills)
})

test('handoff: on an expired cache the old chat sees the approx saving, net of Haiku', async ($, on) => {
  const h = handoffEngine(on)
  await start($, 'terminal')
  await h.reply($, { read: 228_000, write: 0 })
  await h.clock.advance(70 * MIN)
  const r = await handoff($)
  // rebuild 228K on Opus 1h = $1.824; beyond a 35K fresh start and the 4K brief: 189K = $1.512;
  // minus Haiku 40K in + 1.5K out = $0.00475; tokens 189,000 - 41,500
  expect(h.calls.notices[0]!.endsWith('Continuing in the new chat saves approx 148K tokens and $1.51.')).toBe(true)
})

test('handoff: a refused notice falls back to the command output, so the line is never lost', async ($, on) => {
  const h = handoffEngine(on, { noticeRefused: true })
  await start($, 'terminal')
  const r = await handoff($)
  expect(r.text).toMatch(/^Handoff saved to /)
})

// Seen live at 00:12 on desktop: /clear reused the tab (old chat out of view) and the box stayed empty (F52).
test('handoff on desktop: no /clear; the command output and a pop-up carry the line, copied', async ($, on) => {
  const h = handoffEngine(on, { surface: 'desktop' })
  await start($, 'desktop')
  const r = await handoff($)
  await settle(h)
  expect(h.calls.clears).toBe(0)
  expect(h.calls.fills.length).toBe(0)
  expect(h.calls.copies.length).toBe(1)
  expect(h.calls.copies[0]).toMatch(/^Read \/Users\/x\/proj\/\.claude\/handoffs\/.+-chat-1\.md and continue from where we left off\.$/)
  expect(h.calls.notices).toEqual([]) // the desktop app doesn't draw a notice row (F53)
  expect(r.text).toMatch(/To continue, start a new chat and paste \(auto-copied\): Read \/Users\/x\/proj\/\.claude\/handoffs\/.+-chat-1\.md and continue from where we left off\.$/)
})

// VS Code clears and fills like the terminal; its notice row is kept but not drawn (F70, F71).
test('handoff in VS Code: clears to a fresh chat with the line in its box, unsent', async ($, on) => {
  const h = handoffEngine(on, { surface: 'vscode' })
  await start($, 'vscode')
  const r = await handoff($)
  await h.clock.advance(1)
  await w8()
  expect(r.text).toBe(undefined)
  expect(h.calls.clears).toBe(1)
  await $.classic.SessionStart({ source: 'clear', session_id: 'chat-2', model: 'claude-opus-5-5' } as never)
  await w8()
  expect(h.calls.copies).toEqual([])
  expect(h.calls.fills[0]).toMatch(/^Read \/Users\/x\/proj\/\.claude\/handoffs\/.+-chat-1\.md and continue from where we left off\.$/)
})

// Only the terminal clears: the line goes in the fresh chat's box, the notice stays in the old chat.
test('handoff in the terminal: clears to a fresh chat, line in its box, notice kept in the old chat', async ($, on) => {
  const h = handoffEngine(on, { surface: 'terminal' })
  await start($, 'terminal')
  const r = await handoff($)
  await h.clock.advance(1)
  await w8()
  expect(r.text).toBe(undefined)
  expect(h.calls.notices.length).toBe(1)
  expect(h.calls.clears).toBe(1)
  await $.classic.SessionStart({ source: 'clear', session_id: 'chat-2', model: 'claude-opus-5-5' } as never)
  await w8()
  expect(h.calls.copies).toEqual([])
  expect(h.calls.fills[0]).toMatch(/^Read \/Users\/x\/proj\/\.claude\/handoffs\/.+-chat-1\.md and continue from where we left off\.$/)
})

// Sending into an expired big chat warns once and never blocks (RULES); checked on the terminal.
test('send warning in the terminal: a red chat warns, the message still goes through unchanged', async ($, on) => {
  const w = engine(on)
  on('prompt.submit', (_, e) => ({ text: (e as { text: string }).text }) as never)
  await start($, 'terminal')
  await $.classic.SessionStart({ source: 'resume', session_id: 'chat-1', seconds_since_last_response: 7200, context_tokens: 290_000, prompt_cache_likely_expired: true, model: 'claude-opus-5-5' } as never)
  const r = await $.prompt.submit({ text: 'carry on', wait: false, origin: { kind: 'composer' } } as never)
  expect((r as { text: string; drop?: unknown }).text).toBe('carry on')
  expect((r as { drop?: unknown }).drop).toBe(undefined)
  expect(w.toasts.filter(t => t.includes('Heads-up: ')).length).toBe(1)
  // the engine's own turns (claude -p) never warn
  await $.prompt.submit({ text: 'x', wait: false, origin: { kind: 'sdk' } } as never)
  expect(w.toasts.filter(t => t.includes('Heads-up: ')).length).toBe(1)
})

// --- review fixes (2026-11-17) ----------------------------------------------------
test('a broken store never costs the commands, the bar or the pop-up', async ($, on) => {
  const w = engine(on, { brokenStore: true })
  await start($)
  expect(w.commands).toEqual(['cache-monitor', 'cache-monitor-handoff', 'cache-monitor-model', 'cache-monitor-update', 'cache-monitor-stats'])
  await w.reply($, { read: 290_000, write: 0 })
  await w.clock.advance(MIN)
  await expectBar($, '🟢 59:00 min left · next message ≈ $0.06 · 290K / 1M · ✅ Keep going')
  await w.clock.advance(61 * MIN)
  expect(w.toasts.filter(t => t.includes('🔴 cache expired')).length).toBe(1)
})

test('weeks away: an 8-day-old record is pruned (7-day rule), and a resume still fills the bar', async ($, on) => {
  const old = { at: T0 - 8 * 24 * 60 * MIN, prefix: 50_000, out: 0, model: 'claude-opus-5-5', read: 50_000, write: 0, ttlMin: 60, miss5: 0, warned: false, window: 1_000_000 }
  engine(on, { store: { 'cmx:chat-1': old } })
  await start($)
  await expectBar($, WAITING) // pruned: kept, it would show its expired record
  await $.classic.SessionStart({ source: 'resume', session_id: 'chat-1', seconds_since_last_response: 30 * 24 * 3600, context_tokens: 290_000, prompt_cache_likely_expired: true, model: 'claude-opus-5-5' } as never)
  await expectBar($, '🔴 cache expired · next message ≈ $2.32 (40× more) · 290K / 1M · 🔄 Try /cache-monitor-handoff to save 206K tokens | $2.00')
})

test('clock set back: a record from the "future" still gives a valid bar', async ($, on) => {
  const saved = { at: T0 + 10 * MIN, prefix: 50_000, out: 0, model: 'claude-opus-5-5', read: 50_000, write: 0, ttlMin: 60, miss5: 0, warned: false, window: 1_000_000 }
  engine(on, { store: { 'cmx:chat-1': saved } })
  await start($)
  const out = await bars($)
  expect(out.some(t => !t || /NaN|-\d/.test(t))).toBe(false)
})

test('handoff: the folder gets a .gitignore once, so briefs never reach git', async ($, on) => {
  const h = handoffEngine(on)
  let exists = false
  on('fs.stat', (_, e) => { if (exists && String((e as { path: string }).path).endsWith('.gitignore')) return { value: { kind: 'file' } } as never; throw new Error('missing') })
  await start($, 'vscode')
  await handoff($)
  expect(h.calls.writes[1]!.path.endsWith('/.claude/handoffs/.gitignore')).toBe(true)
  expect(h.calls.writes[1]!.text).toBe('*\n')
  exists = true
  await handoff($)
  expect(h.calls.writes.filter(w => w.path.endsWith('.gitignore')).length).toBe(1)
})

test('handoff: a /clear more than 30 s later (your own) gets an empty box, not the old line', async ($, on) => {
  const h = handoffEngine(on)
  await start($, 'vscode')
  await handoff($)
  await h.clock.advance(1) // the clear is queued, but its fresh chat never opens (you sent a message first)
  await w8()
  expect(h.calls.clears).toBe(1)
  await h.clock.advance(31_000)
  await w8()
  await $.classic.SessionStart({ source: 'clear', session_id: 'chat-2', model: 'claude-opus-5-5' } as never)
  await w8()
  expect(h.calls.fills).toEqual([])
})

// --- /cache-monitor-stats (0.3.0) --------------------------------------------------------
async function stats($: Dollar) {
  return String((await $.command.run({ command: 'cache-monitor-stats', args: '' } as never)).text)
}

test('stats: replies, a cold rebuild after expiry, and all chats adding up', async ($, on) => {
  const retired = { since: T0 - 60 * 24 * 60 * MIN, replies: 5, read: 0, write: 0, input: 0, rebuilds: 0, rebuildTokens: 0, rebuildUsd: 0, handoffs: 0, savedTokens: 0, savedUsd: 0, haikuUsd: 0, chats: 1 }
  const w = engine(on, { store: { 'st:retired': retired } }) // chats pruned earlier
  await start($)
  await w.reply($, { read: 0, write: 228_000 }) // first reply: no earlier record, so not a rebuild
  await w.clock.advance(70 * MIN)
  await w.reply($, { read: 0, write: 228_000 }) // after the hour: a rebuild, priced as the 1h write
  await w.clock.advance(5 * MIN)
  await w.reply($, { read: 228_000, write: 0 }) // warm: not a rebuild
  const t = await stats($)
  expect(t).toContain('| Cold rebuilds paid | 1 (228K tokens, $1.82) | 1 (228K tokens, $1.82) |')
  expect(t).toContain('| Replies | 3 | 8 |')
  expect(t).toContain('| Chats | – | 2 |')
  expect(t).toContain('| Cache hit rate | 33% | 33% |')
})

test('stats: a handoff\'s saving counts once, when its line is sent in the new chat', async ($, on) => {
  const h = handoffEngine(on, { surface: 'desktop' })
  on('prompt.submit', (_, e) => ({ text: (e as { text: string }).text }) as never)
  await start($, 'desktop')
  await h.reply($, { read: 228_000, write: 0 })
  await h.clock.advance(70 * MIN)
  await handoff($)
  await handoff($) // run twice: two files, one of them used
  let t = await stats($)
  expect(t).toContain('| Handoffs | 2 | 2 |')
  expect(t).toContain('| Tokens saved (est.) | 0 | 0 |') // nothing used yet
  const line = h.calls.copies[1]!
  await $.prompt.submit({ text: line, wait: false, origin: { kind: 'composer' } } as never) // pasted into the old chat: no saving
  expect(await stats($)).toContain('| Tokens saved (est.) | 0 | 0 |')
  h.session.id = 'chat-2' // the new chat
  await $.prompt.submit({ text: line, wait: false, origin: { kind: 'composer' } } as never)
  await $.prompt.submit({ text: h.calls.copies[0]!, wait: false, origin: { kind: 'composer' } } as never) // the other run's line: the same rebuild
  h.session.id = 'chat-1'
  t = await stats($)
  // 228K - 35K fresh start - 4K brief - 41.5K Haiku = 147.5K; $1.824 x 189/228 - $0.00475 = $1.507
  expect(t).toContain('| Tokens saved (est.) | 148K | 148K |')
  expect(t).toContain('| Saved by handoffs (est.) | $1.51 | $1.51 |')
})

test('stats: a broken store still answers /cache-monitor-stats, with zeros', async ($, on) => {
  engine(on, { brokenStore: true })
  await start($)
  expect(await stats($)).toContain('| Replies | 0 | 0 |')
})

// --- 0.4.0: stats fill-in, /cache-monitor-update -----------------------------------------------
const TRANSCRIPT = [
  JSON.stringify({ type: 'assistant', timestamp: '2026-11-17T10:00:00Z', message: { id: 'a1', model: 'claude-opus-5-5', usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 228_000, output_tokens: 0 } } }),
  JSON.stringify({ type: 'assistant', timestamp: '2026-11-17T12:00:00Z', message: { id: 'a2', model: 'claude-opus-5-5', usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 228_000, output_tokens: 0 } } }),
].join('\n')

function onDisk(on: On, size: number) {
  const reads = { n: 0 }
  on('fs.stat', () => ({ value: { kind: 'file', size } }) as never)
  // a whole read; the tail read for the reply's speed (with a length) is not one
  on('fs.read', (_, e) => { if ((e as { length?: number }).length === undefined) reads.n++; return { value: TRANSCRIPT } as never })
  return reads
}
const resume = ($: Dollar) => $.classic.SessionStart({ source: 'resume', session_id: 'chat-1', transcript_path: '/t/chat-1.jsonl', model: 'claude-opus-5-5' } as never)

test('stats fill-in: an older chat\'s history is read once from its transcript, then counted live', async ($, on) => {
  const w = engine(on)
  const reads = onDisk(on, 1_000)
  await start($)
  await resume($)
  await resume($) // already filled: not read again
  expect(reads.n).toBe(1)
  expect(await stats($)).toContain('| Cold rebuilds paid | 1 (228K tokens, $1.82) | 1 (228K tokens, $1.82) |')
  await w.reply($, { read: 228_000, write: 0 })
  const t = await stats($)
  expect(t).toContain('| Replies | 3 | 3 |')
  expect(t).toContain('| Chats | – | 1 |')
})

test('stats fill-in: a transcript over 4 MiB is not read; the column says since when it was counted', async ($, on) => {
  const w = engine(on)
  const reads = onDisk(on, 5 * 1024 * 1024)
  await start($)
  await resume($)
  await w.reply($, { read: 228_000, write: 0 })
  expect(reads.n).toBe(0)
  const t = await stats($)
  expect(t).toContain('| | This chat (since 2027-01-15) | All chats |')
  expect(t).toContain('| Replies | 1 | 1 |')
})

function updateEngine(on: On, o: { latest?: string; prices?: unknown; processExit?: number; offline?: boolean; pricesFail?: boolean; store?: Record<string, unknown> } = {}) {
  const w = engine(on, { store: o.store })
  const calls = { argv: [] as string[][], urls: [] as string[] }
  on('fs.read', (_, e) => {
    if (String((e as { path: string }).path).replace(/\\/g, '/').endsWith('/.claude-plugin/plugin.json')) return { value: JSON.stringify({ name: 'cache-monitor', version: '0.4.0' }) } as never
    throw new Error('unexpected read')
  })
  on('http.fetch', (_, e) => {
    const url = (e as { url: string }).url
    calls.urls.push(url)
    if (o.offline || (o.pricesFail && url.endsWith('prices.json'))) throw new Error('ENOTFOUND')
    const body = url.endsWith('plugin.json') ? { version: o.latest ?? '0.4.0' } : (o.prices ?? { sourceDate: '2026-12-02', prices: { 'opus-5-5': [4, 0.2], 'opus-6': [5, 0.5] } })
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } } as never
  })
  on('process.run', (_, e) => {
    calls.argv.push([...(e as { argv: string[] }).argv])
    if (o.processExit === undefined) throw new Error('not available on this surface')
    return { value: { exitCode: o.processExit, stdout: '', stderr: '' } } as never
  })
  on('ui.log', () => ({ value: undefined }))
  return { ...w, calls }
}
const runUpdate = async ($: Dollar) => String((await $.command.run({ command: 'cache-monitor-update', args: '' } as never)).text)

test('update, same version: only this repo\'s files are read, and a new model is priced at once', async ($, on) => {
  const u = updateEngine(on)
  await start($)
  const t = await runUpdate($)
  expect(t).toBe('cache-monitor 0.4.0 is the latest version. Prices updated to 2026-12-02: new claude-opus-6.')
  expect(u.calls.argv).toEqual([])
  expect(u.calls.urls.every(x => x.startsWith('https://raw.githubusercontent.com/lucabertani/claude-plugin-cache-monitor/main/'))).toBe(true)
  await u.reply($, { read: 50_000, write: 0, model: 'claude-opus-6' })
  await expectBar($, '🟢 60:00 min left · next message ≈ $0.03 · 50K / 1M · ✅ Keep going')
  expect(await runUpdate($)).toContain('Prices: up to date (2026-12-02).')
})

test('update, newer version: Claude Code\'s updater runs where it may; elsewhere the reply says how', async ($, on) => {
  const u = updateEngine(on, { latest: '0.5.0', processExit: 0 })
  await start($)
  expect(await runUpdate($)).toContain('Updated cache-monitor 0.4.0 → 0.5.0. Run /reload-plugins')
  expect(u.calls.argv).toEqual([['claude', 'plugin', 'update', 'cache-monitor@cache-monitor']])
})

test('update, newer version but the updater is refused: manual steps, and prices still refreshed', async ($, on) => {
  updateEngine(on, { latest: '0.5.0' })
  await start($)
  const t = await runUpdate($)
  expect(t).toContain('Version 0.5.0 is out (you have 0.4.0). To update:')
  expect(t).toContain('Enable auto-update')
  expect(t).toContain('Prices updated to 2026-12-02')
})

test('update: offline or a bad table changes nothing', async ($, on) => {
  updateEngine(on, { offline: true })
  await start($)
  expect(await runUpdate($)).toMatch(/^cache-monitor: Couldn't check for a new version \(.*\)\. Prices not checked \(.*\)\. Nothing changed\.$/)
})

test('update: a refused price table leaves the prices as they were', async ($, on) => {
  const u = updateEngine(on, { prices: { sourceDate: '2026-12-02', prices: { 'opus-5-5': [4, 9] } } })
  await start($)
  expect(await runUpdate($)).toContain('Prices not changed: the downloaded table was refused (bad price for opus-5-5).')
  await u.reply($, { read: 50_000, write: 0 })
  await expectBar($, '🟢 60:00 min left · next message ≈ $0.01 · 50K / 1M · ✅ Keep going')
})

test('prices saved by an earlier /cache-monitor-update are used after a restart', async ($, on) => {
  const w = engine(on, { store: { prices: { sourceDate: '2026-12-02', prices: { 'opus-6': [5, 0.5] } } } })
  await start($)
  await w.reply($, { read: 50_000, write: 0, model: 'claude-opus-6' })
  await expectBar($, '🟢 60:00 min left · next message ≈ $0.03 · 50K / 1M · ✅ Keep going')
})

// --- final-review fixes ------------------------------------------------------------
test('a session that never gets a reply is not a chat; a non-interactive one is never counted', async ($, on) => {
  const w = engine(on)
  on('fs.stat', () => { throw new Error('ENOENT') }) // a new chat: no transcript yet
  await start($)
  await $.classic.SessionStart({ source: 'startup', session_id: 'chat-1', transcript_path: '/t/chat-1.jsonl', model: 'claude-opus-5-5' } as never)
  expect(await stats($)).toContain('| Chats | – | 0 |')
  await w.reply($, { read: 0, write: 50_000 })
  expect(await stats($)).toContain('| Chats | – | 1 |')
})

test('claude -p and other non-interactive sessions are not counted', async ($, on) => {
  const w = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: false })
  await w.reply($, { read: 0, write: 50_000 })
  expect(await stats($)).toContain('| Replies | 0 | 0 |')
})

test('a fork does not read its transcript (the parent\'s rows): counted from its first reply', async ($, on) => {
  const w = engine(on)
  const reads = onDisk(on, 1_000)
  await start($)
  await $.classic.SessionStart({ source: 'fork', session_id: 'chat-1', transcript_path: '/t/chat-1.jsonl', model: 'claude-opus-5-5' } as never)
  await w.reply($, { read: 228_000, write: 0 })
  expect(reads.n).toBe(0)
  expect(await stats($)).toContain('| Replies | 1 | 1 |')
})

test('after 90 days a chat is retired into the totals; resumed, it is not read or counted again', async ($, on) => {
  const old = { since: T0 - 100 * 24 * 60 * MIN, at: T0 - 100 * 24 * 60 * MIN, replies: 2, read: 0, write: 0, input: 0, rebuilds: 0, rebuildTokens: 0, rebuildUsd: 0, handoffs: 0, savedTokens: 0, savedUsd: 0, isFilled: true }
  engine(on, { store: { 'st:chat-1': old } })
  const reads = onDisk(on, 1_000)
  await start($)
  await w8() // prune runs in the background
  await resume($)
  expect(reads.n).toBe(0)
  const t = await stats($)
  expect(t).toContain('| Replies | 0 | 2 |')
  expect(t).toContain('| Chats | – | 1 |')
})

test('update: a failed price download never hides a finished update', async ($, on) => {
  updateEngine(on, { latest: '0.5.0', processExit: 0, pricesFail: true })
  await start($)
  const t = await runUpdate($)
  expect(t).toContain('Updated cache-monitor 0.4.0 → 0.5.0. Run /reload-plugins')
  expect(t).toContain('Prices not checked (')
  expect(t.includes('Nothing changed')).toBe(false)
})

test('a downloaded table dated like the built-in one never overrides it', async ($, on) => {
  const same = { sourceDate: PRICES_DATE, prices: { 'opus-5-5': [9, 0.9] } }
  const u = updateEngine(on, { store: { prices: same }, prices: same })
  await start($)
  await u.reply($, { read: 50_000, write: 0 })
  await expectBar($, '🟢 60:00 min left · next message ≈ $0.01 · 50K / 1M · ✅ Keep going') // bundled $4/$0.20, not $9
  expect(await runUpdate($)).toContain(`Prices: up to date (${PRICES_DATE}).`)
})

test('handoff: the handoffModel option picks the summary model', { options: { handoffModel: 'claude-sonnet-5-5' } }, async ($, on) => {
  const h = handoffEngine(on)
  await start($, 'terminal')
  await handoff($)
  expect(h.calls.model[0]!.model).toBe('claude-sonnet-5-5')
  expect(h.calls.writes[0]!.text).toContain('Sonnet wrote the judgment sections')
})

test('handoff: an argument picks the model for this run only; junk is refused', async ($, on) => {
  const h = handoffEngine(on)
  await start($, 'terminal')
  await handoff($, ' opus ')
  expect(h.calls.model[0]!.model).toBe('opus')
  const r = (await handoff($, 'not a model')) as { text?: string }
  expect(r.text).toContain('is not a model name')
  expect(h.calls.model.length).toBe(1)
})

test('/cache-monitor-model: a listed name sets the picker; any other id goes to the custom field', async ($, on) => {
  engine(on)
  const vals: Record<string, string> = {}
  const OPTS = ['haiku', 'sonnet', 'opus', 'claude-sonnet-5-5', 'custom']
  on('config.list', () => ({ value: [{ key: 'cache-monitor.handoffModel', label: 'Handoff model', kind: 'choice', value: vals['cache-monitor.handoffModel'] ?? 'haiku', options: OPTS, provider: { plugin: 'cache-monitor' }, isLocked: false }] }) as never)
  on('config.set', (_, e) => { const x = e as { key: string; value: string }; vals[x.key] = x.value; return { value: x.value } as never })
  await start($, 'terminal')
  const run = async (args: string) => ((await $.command.run({ command: 'cache-monitor-model', args } as never)) as { text: string }).text
  expect(await run('')).toContain('Handoff model: haiku')
  expect(await run('sonnet')).toBe('Handoff model set to sonnet. /cache-monitor-handoff uses it from now on.')
  expect(vals).toEqual({ 'cache-monitor.handoffModel': 'sonnet' })
  expect(await run('claude-sonnet-5-5-20260401')).toBe('Handoff model set to claude-sonnet-5-5-20260401 (custom). /cache-monitor-handoff uses it from now on.')
  expect(vals).toEqual({ 'cache-monitor.handoffModel': 'custom', 'cache-monitor.handoffModelCustom': 'claude-sonnet-5-5-20260401' })
  expect(await run('not a model')).toContain('is not a model name')
})


// --- 0.6.0: the reviewed cases ------------------------------------------------------------
test('TTL is learned from each reply: a 5-minute write counts down from 5, and prices writes at 1.25x', async ($, on) => {
  const w = engine(on)
  await start($)
  await w.reply($, { read: 0, write: 100_000, e5m: 100_000, e1h: 0 })
  await w.clock.advance(1 * MIN)
  await expectBar($, '🟢 4:00 min left · next message ≈ $0.02 · 100K / 1M · ✅ Keep going')
  await w.reply($, { read: 100_000, write: 0 }) // a pure read keeps the 5-minute lifetime
  await w.clock.advance(6 * MIN)
  // 100K x $4 x 1.25 = $0.50; 65K beyond a 35K fresh start = $0.325, under the $0.50 limit
  // a handoff would still save a little ($0.30), so the text doesn't claim a new chat costs the same
  await expectBar($, '🟠 cache expired · next message ≈ $0.50 (25× more) · 100K / 1M · Rebuild under your limit, fine to keep going')
  await w.reply($, { read: 0, write: 100_000, e5m: 0, e1h: 100_000 })
  await expectBar($, '🟢 60:00 min left · next message ≈ $0.02 · 100K / 1M · ✅ Keep going')
})

test('the forced 5-minute setting wins over what a reply wrote', { options: { memoryMinutes: '5' } }, async ($, on) => {
  const w = engine(on)
  await start($)
  await w.reply($, { read: 0, write: 50_000, e5m: 0, e1h: 50_000 })
  await expectBar($, '🟢 5:00 min left · next message ≈ $0.01 · 50K / 1M · ✅ Keep going')
})

test('resume: the saved record of the last request beats the session-start estimate of its end', async ($, on) => {
  const w = engine(on, { streamMs: 4 * MIN })
  await start($)
  await w.reply($, { read: 50_000, write: 0, out: 1_000 })
  await w.clock.advance(10 * MIN) // the reply ended 4 min after its start; 10 min since
  await $.session.end({ sessionId: 'chat-1' } as never)
  await $.classic.SessionStart({ source: 'resume', session_id: 'chat-1', seconds_since_last_response: 600, context_tokens: 51_000, model: 'claude-opus-5-5' } as never)
  // from the request's start: 60 - 4 - 10 = 46 min left, not 50
  await expectBar($, '🟢 46:00 min left · next message ≈ $0.02 · 51K / 1M · ✅ Keep going')
})

test('compact: a context figure of 0 is no figure, and the system prompt layer stays cached', { }, async ($, on) => {
  const w = engine(on, { contextTokens: 0 })
  await start($)
  await w.reply($, { read: 228_000, write: 0 })
  await $.classic.PostCompact({ trigger: 'manual', compact_summary: 'x'.repeat(40_000) } as never)
  // 10K summary + 20K system layer = 30K: 20K read at $0.20/M + 10K written at $8/M = $0.084
  await expectBar($, '🟠 cache reset (chat compacted) · next message ≈ $0.08 (14× more) · 30K / 1M · Small rebuild (a new chat costs about as much), fine to keep going')
})

test('stats: a reply that read far less than the chat held while warm counts as a rebuild', async ($, on) => {
  const w = engine(on)
  await start($)
  await w.reply($, { read: 200_000, write: 0 })
  await w.clock.advance(5 * MIN)
  await w.reply($, { read: 20_000, write: 180_000, e5m: 0, e1h: 180_000 }) // fast mode toggled, effort changed...
  expect(await stats($)).toContain('| Cold rebuilds paid | 1 (180K tokens, $1.44) | 1 (180K tokens, $1.44) |')
})

test('fast mode: read from the transcript, it doubles the price', async ($, on) => {
  const w = engine(on)
  on('fs.stat', () => ({ value: { kind: 'file', size: 100 } }) as never)
  on('fs.read', () => ({ value: JSON.stringify({ type: 'assistant', message: { usage: { speed: 'fast' } } }) }) as never)
  await start($)
  await $.classic.SessionStart({ source: 'startup', session_id: 'chat-1', transcript_path: '/t/chat-1.jsonl', model: 'claude-opus-5-5' } as never)
  await w.reply($, { read: 228_000, write: 0 })
  await w.clock.advance(70 * MIN)
  await expectBar($, '🔴 cache expired · next message ≈ $3.65 (40× more) · 228K / 1M · 🔄 Try /cache-monitor-handoff to save 144K tokens | $3.02')
})

test('stats: a new chat counted live is never replaced by its transcript on a later resume', async ($, on) => {
  const w = engine(on)
  let onDiskNow = false
  const reads = { n: 0 }
  on('fs.stat', () => { if (!onDiskNow) throw new Error('ENOENT'); return { value: { kind: 'file', size: 1_000 } } as never })
  on('fs.read', (_, e) => { if ((e as { length?: number }).length === undefined) reads.n++; return { value: TRANSCRIPT } as never })
  await start($)
  await $.classic.SessionStart({ source: 'startup', session_id: 'chat-1', transcript_path: '/t/chat-1.jsonl', model: 'claude-opus-5-5' } as never)
  await w.reply($, { read: 0, write: 50_000 })
  await $.classic.PostModelSwitch({ source: 'command', from_model: 'claude-opus-5-5', to_model: 'claude-sonnet-5-5', context_tokens: 50_000 } as never)
  await w.reply($, { read: 0, write: 50_000, model: 'claude-sonnet-5-5' }) // a rebuild only live counting sees
  await $.session.end({ sessionId: 'chat-1' } as never)
  onDiskNow = true
  await resume($)
  expect(reads.n).toBe(0)
  const t = await stats($)
  expect(t).toContain('| Replies | 2 | 2 |')
  expect(t).toContain('| Cold rebuilds paid | 1 (50K tokens, $0.20) | 1 (50K tokens, $0.20) |')
})

test('prune: a chat already folded into the totals is not counted twice when its marker write failed', async ($, on) => {
  const at = T0 - 100 * 24 * 60 * MIN
  const old = { since: at, at, replies: 2, read: 0, write: 0, input: 0, rebuilds: 0, rebuildTokens: 0, rebuildUsd: 0, handoffs: 0, savedTokens: 0, savedUsd: 0, isFilled: true }
  const retired = { since: at, replies: 2, read: 0, write: 0, input: 0, rebuilds: 0, rebuildTokens: 0, rebuildUsd: 0, handoffs: 0, savedTokens: 0, savedUsd: 0, chats: 1, folded: { [`st:chat-9@${at}`]: at } }
  engine(on, { store: { 'st:chat-9': old, 'st:retired': retired } })
  await start($)
  expect(await stats($)).toContain('| Replies | 0 | 2 |') // before the prune finishes, too
  await w8()
  const t = await stats($)
  expect(t).toContain('| Replies | 0 | 2 |')
  expect(t).toContain('| Chats | – | 1 |')
})

test('prune: a retired chat resumed keeps its new counts, folded in again later', async ($, on) => {
  const at = T0 - 100 * 24 * 60 * MIN
  const back = { since: at, at, isFilled: true, retired: true, replies: 3, read: 0, write: 0, input: 0, rebuilds: 0, rebuildTokens: 0, rebuildUsd: 0, handoffs: 0, savedTokens: 0, savedUsd: 0 }
  const retired = { since: at, replies: 2, read: 0, write: 0, input: 0, rebuilds: 0, rebuildTokens: 0, rebuildUsd: 0, handoffs: 0, savedTokens: 0, savedUsd: 0, chats: 1 }
  engine(on, { store: { 'st:chat-9': back, 'st:retired': retired } })
  await start($)
  await w8()
  const t = await stats($)
  expect(t).toContain('| Replies | 0 | 5 |')
  expect(t).toContain('| Chats | – | 1 |')
})


// --- 0.6.1: second review ------------------------------------------------------------------
test('a write with no 5m/1h split (a provider that reports none) is a 5-minute cache', async ($, on) => {
  const w = engine(on)
  await start($)
  await w.reply($, { read: 0, write: 50_000, noSplit: true })
  await w.clock.advance(1 * MIN)
  await expectBar($, '🟢 4:00 min left · next message ≈ $0.01 · 50K / 1M · ✅ Keep going')
})

test('resume: Claude Code\'s own "likely expired" corrects a 1-hour guess for a 5-minute chat', async ($, on) => {
  engine(on)
  await start($)
  await $.classic.SessionStart({ source: 'resume', session_id: 'chat-1', seconds_since_last_response: 600, context_tokens: 290_000, prompt_cache_likely_expired: true, model: 'claude-opus-5-5' } as never)
  const b = (await bars($))[0]!
  expect(b.startsWith('🔴 cache expired · next message ≈ $1.45')).toBe(true) // 290K x $4 x 1.25
})

test('model A → B → A while A\'s cache lives: no reset, and the next reply is no rebuild', async ($, on) => {
  const w = engine(on)
  await start($)
  await w.reply($, { read: 228_000, write: 0 })
  await $.classic.PostModelSwitch({ source: 'command', from_model: 'claude-opus-5-5', to_model: 'claude-sonnet-5-5', context_tokens: 228_000, cache_ttl: '1h' } as never)
  await w.clock.advance(1 * MIN)
  await $.classic.PostModelSwitch({ source: 'command', from_model: 'claude-sonnet-5-5', to_model: 'claude-opus-5-5', context_tokens: 228_000, cache_ttl: '1h' } as never)
  await expectBar($, '🟢 59:00 min left · next message ≈ $0.05 · 228K / 1M · ✅ Keep going')
  await w.reply($, { read: 228_000, write: 0 })
  expect(await stats($)).toContain('| Cold rebuilds paid | 0 | 0 |')
})

test('a model switch after a compaction keeps nothing cached: the new model writes it all', async ($, on) => {
  const w = engine(on, { contextTokens: 30_000 })
  await start($)
  await w.reply($, { read: 228_000, write: 0 })
  await $.classic.PostCompact({ trigger: 'manual', compact_summary: 'x' } as never)
  await $.classic.PostModelSwitch({ source: 'command', from_model: 'claude-opus-5-5', to_model: 'claude-sonnet-5-5', context_tokens: 30_000, cache_ttl: '1h' } as never)
  // 30K x $2 x 2 = $0.12, not $0.04 with 20K still read
  expect((await bars($))[0]!).toContain('next message ≈ $0.12')
})

test('a second handoff while the first is being written is refused: one clear, one Haiku call', async ($, on) => {
  const h = handoffEngine(on)
  await start($, 'terminal')
  const [a, b] = await Promise.all([handoff($), handoff($)])
  await settle(h)
  expect(h.calls.model.length).toBe(1)
  expect(h.calls.clears).toBe(1)
  expect([a, b].some(r => String((r as { text?: string }).text).includes('already being written'))).toBe(true)
})

test('prune: a prunedAt from a clock that ran ahead does not stop pruning', async ($, on) => {
  const old = { at: T0 - 8 * 24 * 60 * MIN, prefix: 50_000, out: 0, model: 'claude-opus-5-5', read: 0, write: 0, ttlMin: 60, miss5: 0, warned: false }
  const map = new Map<string, unknown>()
  engine(on, { map, store: { prunedAt: T0 + 30 * 24 * 60 * MIN, 'cmx:old': old } })
  await start($)
  await w8()
  expect(map.has('cmx:old')).toBe(false)
})

test('a chat that never got a reply leaves nothing in the store', async ($, on) => {
  const map = new Map<string, unknown>()
  engine(on, { map })
  on('fs.stat', () => { throw new Error('ENOENT') })
  await start($)
  await $.classic.SessionStart({ source: 'startup', session_id: 'chat-1', transcript_path: '/t/chat-1.jsonl', model: 'claude-opus-5-5' } as never)
  await $.session.end({ sessionId: 'chat-1' } as never)
  expect([...map.keys()].filter(k => k.startsWith('st:'))).toEqual([])
})

test('a transcript read keeps the savings counted live', async ($, on) => {
  const live = { since: T0, at: T0, replies: 1, read: 0, write: 0, input: 0, rebuilds: 0, rebuildTokens: 0, rebuildUsd: 0, handoffs: 1, savedTokens: 150_000, savedUsd: 1.5 }
  engine(on, { store: { 'st:chat-1': live } })
  onDisk(on, 1_000)
  await start($)
  await resume($)
  expect(await stats($)).toContain('| Saved by handoffs (est.) | $1.50 | $1.50 |')
})
