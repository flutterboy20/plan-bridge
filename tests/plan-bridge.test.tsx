import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

import { barTitle, cleanTitle, fromUpdatePlan, since, trackParts } from '../hooks/logic'

const BAR_TOOL = 'mcp__plan-progress__plan_progress'
const UPDATE_PLAN = 'mcp__ccd_turn__update_plan'

const BAND = {
  plugin: 'plan-bridge',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 12,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 12 },
    view: {},
  },
} as const

type Sent = { id: string; title: string; steps: { title: string; status: string }[] }

// The engine beneath the mod; with `hasPlanProgress`, plan-progress's tool too, its bars recorded.
function engine(on: On, options: { hasPlanProgress?: boolean } = {}) {
  const sent: Sent[] = []
  const state = { hasPlanProgress: options.hasPlanProgress === true }
  let taskCount = 0
  const clock = mock.clock(on, { now: 1_760_000_000_000 })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('tool.list', () => ({ value: (state.hasPlanProgress ? [{ name: BAR_TOOL }] : [{ name: 'Read' }]) as never }))
  on('tool.call', (_, e) => {
    const raw = e as unknown as Record<string, unknown>
    if (e.tool === BAR_TOOL) {
      if (!state.hasPlanProgress) throw new Error('no tool named mcp__plan-progress__plan_progress')
      const stages = raw.stages as { steps: { title: string; status: string }[] }[]
      sent.push({ id: String(raw.id), title: String(raw.title), steps: stages[0]?.steps ?? [] })

      return { result: 'ok' } as never
    }
    if (e.tool === 'TaskCreate') {
      taskCount += 1

      return { result: { task: { id: String(taskCount), subject: raw.subject } } } as never
    }

    return { result: {} } as never
  })
  // the band's other content beneath this mod
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
  })

  return { sent, state, clock }
}

type Kit = Parameters<TestBody>[0]
const start = ($: Kit) => $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
const call = ($: Kit, tool: string, input: Record<string, unknown> = {}) => $.tool.call({ tool, ...input } as never)
const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' } }) as never
const band = ($: Kit, surface: 'terminal' | 'desktop', bodyColumns = 80, hasSurvey = false) =>
  $.ui.mount({ ...BAND, surface, props: { ...BAND.props, bodyColumns, hasSurvey } })
const statuses = (bar: Sent | undefined) => bar?.steps.map(step => step.status)

const ITEMS = [
  { content: 'Inventory the setup', status: 'in_progress' },
  { content: 'Collect descriptions', status: 'pending' },
  { content: 'Generate the page', status: 'pending' },
]

test('titles, times and the terminal track', () => {
  expect(cleanTitle('  Build\tthe   pricing section ')).toBe('Build the pricing section')
  expect(barTitle('Make an HTML page of my setup. Then open it.')).toBe('Make an HTML page of my setup.')
  expect(barTitle('/better-prompt fix the login screen')).toBe('fix the login screen')
  expect(barTitle('')).toBe('Task')
  expect([since(45_000), since(72_000), since(3_780_000)]).toEqual(['45s', '1m 12s', '1h 3m'])
  const steps = [
    { title: 'a', status: 'done' as const },
    { title: 'b', status: 'active' as const },
    { title: 'c', status: 'pending' as const },
  ]
  for (const width of [24, 80, 141]) {
    expect(trackParts(steps, width).map(([cells]) => cells).join('').length).toBe(width)
  }
  expect(fromUpdatePlan([], { recap: 'x' })).toBeNull()
})

test('on its own, it draws the bar from the desktop task list, on terminal and desktop', async ($, on) => {
  const { sent, clock } = engine(on)
  await start($)
  await $.prompt.submit(typed('Make an HTML page of my Claude Code setup'))
  await call($, UPDATE_PLAN, { items: ITEMS, scope: 'first_task' })
  await clock.advance(72_000)
  await call($, UPDATE_PLAN, { advance: true })
  expect(sent).toHaveLength(0)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await band($, surface)
    expect(await ui.find({ type: 'Text', text: /^Make an HTML page of my Claude Code setup$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^1\/3 · 33% · 1m 12s$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Collect descriptions$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /then Generate the page/ })).toBeDefined()
    expect(await ui.find({ key: 'close-bar' })).toBeDefined()
    if (surface === 'desktop') expect(await ui.find({ type: 'Svg' })).toBeDefined()
    await ui.unmount()
  }
})

test('wrap_up finishes the bar; the next prompt or ✕ puts it away', async ($, on) => {
  engine(on)
  await start($)
  await call($, UPDATE_PLAN, { items: ITEMS })
  await call($, 'mcp__ccd_turn__wrap_up', { recap: 'Done.' })
  let ui = await band($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /^All done · took/ })).toBeDefined()
  await ui.unmount()

  await $.prompt.submit(typed('thanks, now add a footer'))
  ui = await band($, 'terminal')
  expect(await ui.find({ key: 'close-bar' })).toBeUndefined()
  await ui.unmount()

  // a new list shows again, and ✕ closes it
  await call($, UPDATE_PLAN, { items: [{ content: 'Add the footer', status: 'in_progress' }], scope: 'new_task' })
  ui = await band($, 'desktop')
  expect(await ui.find({ type: 'Text', text: /^thanks, now add a footer$/ })).toBeDefined()
  await ui.press({ key: 'close-bar' })
  expect(await ui.find({ key: 'close-bar' })).toBeUndefined()
  await ui.unmount()
})

test("the terminal's task tools and TodoWrite draw the bar too", async ($, on) => {
  engine(on)
  await start($)
  await $.prompt.submit(typed('Add a settings screen'))
  await call($, 'TaskCreate', { subject: 'Design the screen', description: 'x' })
  await call($, 'TaskCreate', { subject: 'Wire the toggles', description: 'x' })
  await call($, 'TaskCreate', { subject: 'Write a test', description: 'x' })
  await call($, 'TaskUpdate', { taskId: '1', status: 'completed' })
  await call($, 'TaskUpdate', { taskId: '2', status: 'in_progress' })
  await call($, 'TaskUpdate', { taskId: '3', status: 'deleted' })
  let ui = await band($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /^1\/2 · 50%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Wire the toggles$/ })).toBeDefined()
  await ui.unmount()

  await call($, 'TodoWrite', {
    todos: [
      { content: 'Read the brief', status: 'completed', activeForm: 'Reading' },
      { content: 'Draft the page', status: 'in_progress', activeForm: 'Drafting' },
    ],
  })
  ui = await band($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /^Draft the page$/ })).toBeDefined()
  await ui.unmount()
})

test('with plan-progress installed it hands the list over and draws nothing itself', async ($, on) => {
  const { sent } = engine(on, { hasPlanProgress: true })
  await start($)
  await call($, UPDATE_PLAN, { items: ITEMS })
  await call($, UPDATE_PLAN, { advance: true })
  expect(sent.map(bar => bar.id)).toEqual(['task-1', 'task-1'])
  expect(statuses(sent.at(-1))).toEqual(['done', 'active', 'pending'])
  const ui = await band($, 'desktop')
  expect(await ui.find({ key: 'close-bar' })).toBeUndefined()
  await ui.unmount()

  // an open bar is sent again every few edits, so plan-progress never has to remind Claude
  for (let n = 0; n < 4; n++) await call($, 'Edit', { file_path: '/a', old_string: 'x', new_string: 'y' })
  expect(sent).toHaveLength(3)
})

test('plan-progress turned off mid-task: it draws the bar itself from then on', async ($, on) => {
  const { state } = engine(on, { hasPlanProgress: true })
  await start($)
  await call($, UPDATE_PLAN, { items: ITEMS })
  state.hasPlanProgress = false
  await call($, UPDATE_PLAN, { advance: true })
  const ui = await band($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /^Collect descriptions$/ })).toBeDefined()
  await ui.unmount()
})

test("a subagent's list is left alone, and a survey keeps the band clear", async ($, on) => {
  engine(on)
  await start($)
  await call($, UPDATE_PLAN, { items: ITEMS, agentId: 'helper-1' })
  let ui = await band($, 'terminal')
  expect(await ui.find({ key: 'close-bar' })).toBeUndefined()
  await ui.unmount()

  await call($, UPDATE_PLAN, { items: ITEMS })
  ui = await band($, 'terminal', 80, true)
  expect(await ui.find({ key: 'close-bar' })).toBeUndefined()
  await ui.unmount()
})

test('a long title fits a narrow band and a wide one', async ($, on) => {
  engine(on)
  await start($)
  await $.prompt.submit(typed('Refactor the whole checkout flow so payments, coupons and receipts share one service'))
  await call($, UPDATE_PLAN, { items: ITEMS })
  for (const width of [30, 140]) {
    const ui = await band($, 'terminal', width)
    const texts = (await ui.findAll({ type: 'Text' })).map(one => one.text)
    const titleText = texts.find(text => text.startsWith('Refactor')) ?? ''
    const right = texts.find(text => text.startsWith('0/3')) ?? ''
    // icon, title, spacing, numbers, a space and ✕ stay within the band
    expect(2 + titleText.length + 1 + right.length + 2).toBeLessThan(width + 1)
    await ui.unmount()
  }
})
