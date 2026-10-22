import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Bar } from '../types'
import { agentSvg, pillLabel, shownAgents, trackCells, trackSvg } from '../hooks/draw'
import { barTitle, cleanTitle, fromUpdatePlan, modelName, since, toolWord } from '../hooks/logic'

const BAR_TOOL = 'mcp__plan-progress__plan_progress'
const UPDATE_PLAN = 'mcp__ccd_turn__update_plan'
const WRAP_UP = 'mcp__ccd_turn__wrap_up'
const START = 1_760_000_000_000

const BAND = {
  plugin: 'plan-bridge',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 12,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 12 },
    view: {},
  },
} as const

type Sent = { id: string; title: string; steps: { title: string; status: string }[] }

// The engine beneath the mod; with `hasPlanProgress`, plan-progress's tool too, its bars recorded.
function engine(on: On, options: { hasPlanProgress?: boolean; failing?: string } = {}) {
  const sent: Sent[] = []
  // what wrap_up reached the app with, and what the prompt was filled with
  const wrapUps: Record<string, unknown>[] = []
  const filled: string[] = []
  const responses: Record<string, unknown>[][] = []
  const state = { hasPlanProgress: options.hasPlanProgress === true, agents: 0 }
  let taskCount = 0
  const clock = mock.clock(on, { now: START })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('prompt.fill', (_, e) => {
    filled.push(e.text)

    return { isFilled: true } as never
  })
  on('tool.list', () => ({ value: (state.hasPlanProgress ? [{ name: BAR_TOOL }] : [{ name: 'Read' }]) as never }))
  on('agent.list', () => ({ value: [] }))
  on('agent.spawn', (_, e) => {
    state.agents += 1

    return { model: e.model ?? 'claude-haiku-4-5-20251001', agentId: `ag${state.agents}` } as never
  })
  on('turn.complete', (_, e) => ({ text: (e as { text?: string }).text ?? '' }) as never)
  // the model's responses, as chunks, one per request
  on('turn.step', async function* (_, e) {
    for (const chunk of responses.shift() ?? []) yield chunk as never
    yield { kind: 'stop', stopReason: 'tool_use', usage: null } as never

    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use', usage: null } as never
  })
  on('classic.PermissionRequest', () => ({}) as never)
  on('tool.call', (_, e) => {
    const raw = e as unknown as Record<string, unknown>
    if (e.tool === BAR_TOOL) {
      if (!state.hasPlanProgress) throw new Error('no tool named mcp__plan-progress__plan_progress')
      const stages = raw.stages as { steps: { title: string; status: string }[] }[]
      sent.push({ id: String(raw.id), title: String(raw.title), steps: stages[0]?.steps ?? [] })

      return { result: 'ok' } as never
    }
    if (e.tool === WRAP_UP) wrapUps.push({ ...raw })
    if (e.tool === 'TaskCreate') {
      taskCount += 1

      return { result: { task: { id: String(taskCount), subject: raw.subject } } } as never
    }
    if (e.tool === options.failing) return { isError: true, result: 'failed', text: 'failed' } as never

    return { result: {} } as never
  })
  // the band's other content beneath this mod
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
  })

  return { sent, wrapUps, filled, responses, state, clock }
}

type Kit = Parameters<TestBody>[0]
const start = ($: Kit) => $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
const call = ($: Kit, tool: string, input: Record<string, unknown> = {}) => $.tool.call({ tool, ...input } as never)
const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' } }) as never
const band = ($: Kit, surface: 'terminal' | 'desktop', bodyColumns = 100, hasSurvey = false) =>
  $.ui.mount({ ...BAND, surface, props: { ...BAND.props, bodyColumns, hasSurvey } })
const spawn = ($: Kit, description: string) =>
  $.agent.spawn({ description, prompt: 'x', subagentType: 'general-purpose', model: 'claude-haiku-4-5-20251001' } as never)
const agentDone = ($: Kit, agentId: string, reason = 'answer') =>
  $.turn.complete({ agentId, reason, turnId: 't', text: 'ok', answer: 'ok', category: null, explanation: null } as never)
const statuses = (bar: Sent | undefined) => bar?.steps.map(step => step.status)
// What a desktop picture says: its markup, as the band drew it.
const sources = async (ui: { findAll: (q: { type: string }) => Promise<{ props: Record<string, unknown> }[]> }) =>
  (await ui.findAll({ type: 'Svg' })).map(one => String(one.props.source))

const ITEMS = [
  { content: 'Inventory the setup', status: 'in_progress' },
  { content: 'Collect descriptions', status: 'pending' },
  { content: 'Generate the page', status: 'pending' },
]

const BAR: Bar = {
  id: 'task-1',
  title: 'Checkout flow',
  steps: [
    { title: 'Scan', status: 'done' },
    { title: 'Build', status: 'active' },
    { title: 'Verify', status: 'pending' },
  ],
  taskIds: ['', '', ''],
  startedAt: START,
  endedAt: null,
  state: 'running',
  note: '',
  agents: [],
  isFed: false,
  isHidden: false,
}

test('titles, models, tools and times read plainly', () => {
  expect(cleanTitle('  Build\tthe   pricing section ')).toBe('Build the pricing section')
  expect(barTitle('Make an HTML page of my setup. Then open it.')).toBe('Make an HTML page of my setup.')
  expect(barTitle('/better-prompt fix the login screen')).toBe('fix the login screen')
  expect(barTitle('I ran /reload-plugins. Run a short live demo with three helpers')).toBe('Run a short live demo with three helpers')
  expect([since(45_000), since(72_000), since(3_780_000)]).toEqual(['45s', '1m 12s', '1h 3m'])
  expect(modelName('claude-haiku-4-5-20251001')).toBe('haiku 4.5')
  expect(modelName('claude-sonnet-5-5')).toBe('sonnet 5.5')
  expect(toolWord('mcp__github__search_code')).toBe('search_code')
  expect(fromUpdatePlan([], { recap: 'x' })).toBeNull()
})

test('the pill names the step at work, and says how the bar stands', () => {
  expect(pillLabel(BAR, START)).toBe('Build')
  expect(pillLabel({ ...BAR, state: 'needs', note: 'Needs your OK' }, START)).toBe('? Needs your OK')
  expect(pillLabel({ ...BAR, state: 'error', note: '' }, START)).toBe('✕ Build')
  expect(pillLabel({ ...BAR, state: 'done', endedAt: START + 134_000 }, START)).toBe('✓ 2m 14s')
  const svg = trackSvg(BAR, 600, START)
  expect(svg).toContain('>Build</text>')
  expect(svg).toContain('class="sh"')
  // the step still ahead gets a mark; the done ones are under the fill
  expect((svg.match(/<circle/g) ?? []).length).toBe(1)
})

test("the terminal's track is one row of cells exactly as wide as asked", () => {
  for (const columns of [10, 47, 120]) {
    const bytes = Uint8Array.from(atob(trackCells(BAR, columns, START)), char => char.charCodeAt(0))
    expect(bytes.length).toBe(columns * 12)
  }
})

test('agent rows: at work first, then the latest finished, the rest counted', () => {
  const agent = (id: string, state: 'running' | 'done', endedAt: number | null) => ({
    id, title: id, model: '', effort: '', tool: 'Read', state, startedAt: START, endedAt, isNested: false,
  })
  const all = [agent('a', 'done', 1), agent('b', 'running', null), agent('c', 'done', 3), agent('d', 'running', null), agent('e', 'done', 2)]
  const { shown, hidden } = shownAgents(all, 3)
  // two rows and the "+N more" line make the three
  expect(shown.map(a => a.id)).toEqual(['b', 'd'])
  expect(hidden.map(a => a.id)).toEqual(['a', 'c', 'e'])
  expect(shownAgents(all.slice(0, 3), 3).hidden).toEqual([])
  const svg = agentSvg({ ...agent('Scan checkout tests', 'running', null), model: 'claude-haiku-4-5-20251001', tool: 'Grep' }, 3, 500, START + 6000)
  expect(svg).toContain('Scan checkout tests')
  expect(svg).toContain('(haiku 4.5)')
  expect(svg).toContain('>Grep</text>')
  expect(svg).toContain('>6s</text>')
})

test('the desktop task list draws the bar, on terminal and desktop', async ($, on) => {
  const { sent, clock } = engine(on)
  await start($)
  await $.prompt.submit(typed('Make an HTML page of my Claude Code setup'))
  await call($, UPDATE_PLAN, { items: ITEMS, scope: 'first_task' })
  await clock.advance(72_000)
  await call($, UPDATE_PLAN, { advance: true })
  expect(sent).toHaveLength(0)

  let ui = await band($, 'desktop')
  const pictures = await sources(ui)
  expect(pictures[0]).toContain('>Collect descriptions</text>')
  expect(await ui.find({ type: 'Text', text: /^Make an HTML page of my Claude Code setup$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /50%/ })).toBeDefined()
  expect((await ui.findAll({ type: 'Button' })).some(one => (one.key ?? '').startsWith('close:'))).toBe(true)
  await ui.unmount()

  ui = await band($, 'terminal')
  expect(await ui.find({ type: 'Raster' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /50%/ })).toBeDefined()
  await ui.unmount()
})

test('subagents get rows under the bar, with model, tool and time, and finish', async ($, on) => {
  const { clock } = engine(on)
  await start($)
  await $.prompt.submit(typed('Review the checkout flow'))
  await call($, UPDATE_PLAN, { items: ITEMS })
  await spawn($, 'Scan checkout tests')
  await spawn($, 'Trace tax rules')
  await call($, 'Grep', { pattern: 'tax', agentId: 'ag2' })
  await clock.advance(4000)

  let ui = await band($, 'desktop')
  let pictures = await sources(ui)
  expect(pictures).toHaveLength(3)
  expect(pictures[1]).toContain('Scan checkout tests')
  expect(pictures[1]).toContain('(haiku 4.5)')
  expect(pictures[2]).toContain('>Grep</text>')
  await ui.unmount()

  await agentDone($, 'ag1')
  await agentDone($, 'ag2', 'error')
  ui = await band($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /Scan checkout tests/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Failed/ })).toBeDefined()
  await ui.unmount()

  // a bar is done only once its steps are and no agent is still at work
  await spawn($, 'Draft release notes')
  await call($, 'mcp__ccd_turn__wrap_up', { recap: 'Done.' })
  ui = await band($, 'desktop')
  pictures = await sources(ui)
  expect(pictures[0]).not.toContain('✓')
  await agentDone($, 'ag3')
  await ui.unmount()
  ui = await band($, 'desktop')
  pictures = await sources(ui)
  expect(pictures[0]).toContain('✓')
  await ui.unmount()
})

test('agents with no task list get a bar of their own, done when the turn is', async ($, on) => {
  engine(on)
  await start($)
  await $.prompt.submit(typed('Research three state libraries'))
  await spawn($, 'Riverpod notes')
  await spawn($, 'Bloc notes')
  let ui = await band($, 'desktop')
  expect((await sources(ui))[0]).toContain('2 agents at work')
  await ui.unmount()
  await agentDone($, 'ag1')
  await agentDone($, 'ag2')
  await $.turn.complete({ reason: 'answer', turnId: 'main', text: 'ok', answer: 'ok', category: null, explanation: null } as never)
  ui = await band($, 'desktop')
  expect((await sources(ui))[0]).toContain('✓')
  await ui.unmount()
})

test('a permission dialog or a question turns the bar amber; the answer clears it', async ($, on) => {
  engine(on)
  await start($)
  await call($, UPDATE_PLAN, { items: ITEMS })
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {}, permission_suggestions: [] } as never)
  let ui = await band($, 'desktop')
  expect((await sources(ui))[0]).toContain('? Needs your OK')
  expect(await ui.find({ type: 'Text', text: /^\?$/ })).toBeDefined()
  await ui.unmount()

  // the call it waited on went ahead
  await call($, 'Bash', { command: 'ls' })
  ui = await band($, 'desktop')
  expect((await sources(ui))[0]).toContain('>Inventory the setup</text>')
  await ui.unmount()
})

test('three failures in a row turn the bar red; a success clears it', async ($, on) => {
  engine(on, { failing: 'Bash' })
  await start($)
  await call($, UPDATE_PLAN, { items: ITEMS })
  for (let n = 0; n < 3; n++) await call($, 'Bash', { command: 'flutter test' })
  let ui = await band($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /^! $/ })).toBeDefined()
  await ui.unmount()
  await call($, 'Read', { file_path: '/a' })
  ui = await band($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /^● $/ })).toBeDefined()
  await ui.unmount()
})

test('a finished bar stays after the next prompt; the next task stacks under it; ✕ closes one', async ($, on) => {
  engine(on)
  await start($)
  await $.prompt.submit(typed('Build the landing page'))
  await call($, UPDATE_PLAN, { items: ITEMS })
  await call($, 'mcp__ccd_turn__wrap_up', { recap: 'Done.' })
  await $.prompt.submit(typed('Now add a footer'))
  let ui = await band($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /^✓ $/ })).toBeDefined()
  await ui.unmount()

  await call($, UPDATE_PLAN, { items: [{ content: 'Add the footer', status: 'in_progress' }], scope: 'new_task' })
  ui = await band($, 'desktop')
  expect(await ui.find({ type: 'Text', text: /^Build the landing page$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Now add a footer$/ })).toBeDefined()
  const closes = (await ui.findAll({ type: 'Button' })).map(one => one.key ?? '').filter(key => key.startsWith('close:'))
  expect(closes).toHaveLength(2)
  await ui.press({ key: closes[0] ?? '' })
  expect(await ui.find({ type: 'Text', text: /^Build the landing page$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^Now add a footer$/ })).toBeDefined()
  await ui.unmount()
})

test("wrap_up's question moves onto the finished bar, its box left out; a reply fills the prompt", async ($, on) => {
  const { wrapUps, filled } = engine(on)
  await start($)
  await $.prompt.submit(typed('Fix the bar'))
  await call($, UPDATE_PLAN, { items: ITEMS })
  await call($, WRAP_UP, {
    recap: 'Fixed.',
    ask: 'Did the bar stay?',
    blocked: true,
    actions: [{ label: 'Worked', message: 'It worked.' }, { label: 'Something off' }],
  })
  expect([wrapUps[0]?.recap, wrapUps[0]?.ask, wrapUps[0]?.actions, wrapUps[0]?.blocked]).toEqual(['Fixed.', undefined, undefined, undefined])

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await band($, surface)
    expect(await ui.find({ type: 'Text', text: /^Did the bar stay\?$/ })).toBeDefined()
    const replies = (await ui.findAll({ type: 'Button' })).filter(one => (one.key ?? '').startsWith('reply:'))
    expect(replies.map(one => one.props.label)).toEqual(['Worked', 'Something off'])
    await ui.unmount()
  }

  let ui = await band($, 'desktop')
  const replies = (await ui.findAll({ type: 'Button' })).filter(one => (one.key ?? '').startsWith('reply:'))
  await ui.press({ key: replies[1]?.key ?? '' })
  await ui.press({ key: replies[0]?.key ?? '' })
  expect(filled).toEqual(['Something off', 'It worked.'])
  await ui.unmount()

  // the person's next prompt answers it: the bar stays, the question goes
  await $.prompt.submit(typed('It worked.'))
  ui = await band($, 'desktop')
  expect(await ui.find({ type: 'Text', text: /^Fix the bar$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Did the bar stay\?$/ })).toBeUndefined()
  await ui.unmount()
})

test("wrap_up's question comes off the call as it streams, so the recorded call has none", async ($, on) => {
  const { responses, wrapUps } = engine(on)
  await start($)
  await $.prompt.submit(typed('Fix the bar'))
  await call($, UPDATE_PLAN, { items: ITEMS })
  const args = JSON.stringify({ recap: 'Fixed.', ask: 'Did it stay?', actions: [{ label: 'Yes', message: 'It stayed.' }] })
  responses.push([
    { kind: 'text', index: 0, text: 'Done.' },
    { kind: 'tool', index: 1, id: 'tu1', name: WRAP_UP },
    { kind: 'input', index: 1, json: args.slice(0, 20) },
    { kind: 'input', index: 1, json: args.slice(20) },
  ])
  const out: Record<string, unknown>[] = []
  for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 2 } as never)) {
    out.push(chunk as unknown as Record<string, unknown>)
  }
  expect(out.map(chunk => chunk.kind)).toEqual(['text', 'tool', 'input', 'stop'])
  const recorded = JSON.parse(String(out[2]?.json)) as Record<string, unknown>
  expect(recorded).toEqual({ recap: 'Fixed.' })

  // the call runs as recorded, and the bar carries the question
  await call($, WRAP_UP, recorded)
  expect(wrapUps[0]?.ask).toBeUndefined()
  const ui = await band($, 'desktop')
  expect(await ui.find({ type: 'Text', text: /^Did it stay\?$/ })).toBeDefined()
  expect((await ui.findAll({ type: 'Button' })).some(one => one.props.label === 'Yes')).toBe(true)
  await ui.unmount()

  // a subagent's wrap_up-free stream, or a question the bar cannot carry, passes as it came
  const keep = JSON.stringify({ recap: 'Ready.', ask: 'Commit?', actions: [{ action: 'commit' }] })
  responses.push([
    { kind: 'tool', index: 0, id: 'tu2', name: WRAP_UP },
    { kind: 'input', index: 0, json: keep },
  ])
  const kept: Record<string, unknown>[] = []
  for await (const chunk of $.turn.step({ turnId: 't2', index: 0, model: 'claude-opus-5-5', messageCount: 2 } as never)) {
    kept.push(chunk as unknown as Record<string, unknown>)
  }
  expect(kept[1]?.json).toBe(keep)
})

test('a question taken off a call that never ran is forgotten when the turn stops', async ($, on) => {
  const { responses } = engine(on)
  await start($)
  await $.prompt.submit(typed('Fix the bar'))
  responses.push([
    { kind: 'tool', index: 0, id: 'tu1', name: WRAP_UP },
    { kind: 'input', index: 0, json: JSON.stringify({ recap: 'Fixed.', ask: 'Old question?', actions: [{ label: 'Yes' }] }) },
  ])
  for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 2 } as never)) void chunk
  // stopped before the wrap_up call ran
  await $.turn.complete({ reason: 'aborted', turnId: 't1', text: '', answer: '', category: null, explanation: null } as never)

  // the next turn ends with no question of its own
  await $.prompt.submit(typed('Try again'))
  await call($, WRAP_UP, { recap: 'Done.' })
  const ui = await band($, 'desktop')
  expect(await ui.find({ type: 'Text', text: /^Old question\?$/ })).toBeUndefined()
  await ui.unmount()
})

test("another turn ending meanwhile (a mod's fork, a ping) keeps the held question", async ($, on) => {
  const { responses } = engine(on)
  await start($)
  await $.prompt.submit(typed('Fix the bar'))
  await call($, UPDATE_PLAN, { items: ITEMS })
  responses.push([
    { kind: 'tool', index: 0, id: 'tu1', name: WRAP_UP },
    { kind: 'input', index: 0, json: JSON.stringify({ recap: 'Fixed.', ask: 'Row showing?', actions: [{ label: 'Yes' }] }) },
  ])
  for await (const chunk of $.turn.step({ turnId: 'main', index: 0, model: 'claude-opus-5-5', messageCount: 2 } as never)) void chunk
  await $.turn.complete({ reason: 'answer', turnId: 'fork', text: '', answer: '', category: null, explanation: null } as never)

  await call($, WRAP_UP, { recap: 'Fixed.' })
  const ui = await band($, 'desktop')
  expect(await ui.find({ type: 'Text', text: /^Row showing\?$/ })).toBeDefined()
  await ui.unmount()
  const report = await $.command.run({ command: 'plan-bridge', args: 'debug' } as never)
  expect(String((report as { text?: string }).text)).toContain('Last question: shown: wrap_up ran with the question held from turn main')
})

test('with no task list the question still moves into the band, alone; an app action keeps its box', async ($, on) => {
  const { wrapUps, filled } = engine(on)
  await start($)
  await $.prompt.submit(typed('Should we ship this?'))
  await call($, WRAP_UP, { recap: 'Looks fine.', ask: 'Push it?', actions: [{ label: 'Yes, push', message: 'Push it.' }] })
  expect(wrapUps[0]?.ask).toBeUndefined()
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await band($, surface)
    expect(await ui.find({ type: 'Text', text: /^Push it\?$/ })).toBeDefined()
    await ui.press({ key: 'reply:0' })
    await ui.unmount()
  }
  expect(filled).toEqual(['Push it.', 'Push it.'])

  await $.prompt.submit(typed('Push it.'))
  const ask = { recap: 'Ready.', ask: 'Commit it?', actions: [{ action: 'commit' }] }
  await call($, UPDATE_PLAN, { items: ITEMS })
  await call($, WRAP_UP, ask)
  expect([wrapUps[1]?.ask, wrapUps[1]?.actions]).toEqual(['Commit it?', [{ action: 'commit' }]])
  const ui = await band($, 'desktop')
  expect(await ui.find({ type: 'Text', text: /^Commit it\?$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^Push it\?$/ })).toBeUndefined()
  await ui.unmount()
})

test('agents started at the same moment all get their rows', async ($, on) => {
  engine(on)
  await start($)
  await call($, UPDATE_PLAN, { items: ITEMS })
  await Promise.all([spawn($, 'Read next-steps manifest'), spawn($, 'List cache-tax commands'), spawn($, 'Count mod-picker tests')])
  const ui = await band($, 'desktop')
  const pictures = await sources(ui)
  expect(pictures).toHaveLength(4)
  for (const name of ['Read next-steps manifest', 'List cache-tax commands', 'Count mod-picker tests']) {
    expect(pictures.some(svg => svg.includes(name))).toBe(true)
  }
  await ui.unmount()
})

test("the terminal's task tools and TodoWrite draw the bar too", async ($, on) => {
  engine(on)
  await start($)
  await call($, 'TaskCreate', { subject: 'Design the screen', description: 'x' })
  await call($, 'TaskCreate', { subject: 'Wire the toggles', description: 'x' })
  await call($, 'TaskUpdate', { taskId: '1', status: 'completed' })
  await call($, 'TaskUpdate', { taskId: '2', status: 'in_progress' })
  let ui = await band($, 'desktop')
  expect((await sources(ui))[0]).toContain('>Wire the toggles</text>')
  await ui.unmount()
  await call($, 'TodoWrite', {
    todos: [
      { content: 'Read the brief', status: 'completed', activeForm: 'Reading' },
      { content: 'Draft the page', status: 'in_progress', activeForm: 'Drafting' },
    ],
  })
  ui = await band($, 'desktop')
  // an unrelated list is the next task: a second bar
  expect((await sources(ui)).some(svg => svg.includes('>Draft the page</text>'))).toBe(true)
  await ui.unmount()
})

test('with plan-progress installed it hands the list over and draws nothing itself', async ($, on) => {
  const { sent, state } = engine(on, { hasPlanProgress: true })
  await start($)
  await call($, UPDATE_PLAN, { items: ITEMS })
  await call($, UPDATE_PLAN, { advance: true })
  expect(statuses(sent.at(-1))).toEqual(['done', 'active', 'pending'])
  let ui = await band($, 'desktop')
  expect((await ui.findAll({ type: 'Button' })).some(one => (one.key ?? '').startsWith('close:'))).toBe(false)
  await ui.unmount()
  // turned off mid-task: it draws the bar itself from then on
  state.hasPlanProgress = false
  await call($, UPDATE_PLAN, { advance: true })
  ui = await band($, 'desktop')
  expect((await ui.findAll({ type: 'Button' })).some(one => (one.key ?? '').startsWith('close:'))).toBe(true)
  await ui.unmount()
})

test('a terminal survey keeps the band clear, a desktop one does not, and a long title fits narrow and wide', async ($, on) => {
  engine(on)
  await start($)
  await $.prompt.submit(typed('Refactor the whole checkout flow so payments, coupons and receipts share one service'))
  await call($, UPDATE_PLAN, { items: ITEMS })
  let ui = await band($, 'terminal', 100, true)
  expect((await ui.findAll({ type: 'Button' })).some(one => (one.key ?? '').startsWith('close:'))).toBe(false)
  await ui.unmount()
  // the desktop draws its survey apart: the bars stay
  ui = await band($, 'desktop', 100, true)
  expect((await ui.findAll({ type: 'Button' })).some(one => (one.key ?? '').startsWith('close:'))).toBe(true)
  await ui.unmount()
  for (const width of [40, 160]) {
    ui = await band($, 'terminal', width)
    const raster = await ui.find({ type: 'Raster' })
    const titleText = (await ui.findAll({ type: 'Text' })).map(one => one.text).find(text => text.startsWith('Refactor')) ?? ''
    // glyph, title, gap, track, percent and ✕ stay within the band
    expect(2 + titleText.length + 1 + Number(raster?.props.columns ?? 0) + 5 + 1).toBeLessThan(width + 1)
    await ui.unmount()
  }
})

test('/plan-bridge debug says what the band last drew and which bars are kept', async ($, on) => {
  engine(on)
  await start($)
  await $.prompt.submit(typed('Build the landing page'))
  await call($, UPDATE_PLAN, { items: ITEMS })
  const ui = await band($, 'desktop')
  await ui.unmount()
  const reply = await $.command.run({ command: 'plan-bridge', args: 'debug' } as never)
  expect(reply.text).toContain('desktop · working true · 100 columns · 12 rows · survey false · bars drawn')
  expect(reply.text).toContain('task-1 "Build the landing page": running, 3 steps, 0 agents')
})
