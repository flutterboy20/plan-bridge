import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

import { barTitle, cleanTitle, fromUpdatePlan } from '../hooks/logic'

const BAR_TOOL = 'mcp__plan-progress__plan_progress'
const UPDATE_PLAN = 'mcp__ccd_turn__update_plan'

type Sent = { id: string; title: string; steps: { title: string; status: string }[] }

// The engine and plan-progress beneath the mod: every call answered, the bars recorded.
function engine(on: On, options: { hasBar?: boolean } = {}) {
  const sent: Sent[] = []
  let taskCount = 0
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('tool.call', (_, e) => {
    const raw = e as unknown as Record<string, unknown>
    if (e.tool === BAR_TOOL) {
      if (options.hasBar === false) throw new Error('no tool named mcp__plan-progress__plan_progress')
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

  return sent
}

type Kit = Parameters<TestBody>[0]
const start = ($: Kit) => $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
const call = ($: Kit, tool: string, input: Record<string, unknown> = {}) => $.tool.call({ tool, ...input } as never)
const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' } }) as never
const statuses = (bar: Sent | undefined) => bar?.steps.map(step => step.status)

const ITEMS = [
  { content: 'Inventory the setup', status: 'in_progress' },
  { content: 'Collect descriptions', status: 'pending' },
  { content: 'Generate the page', status: 'pending' },
]

test('titles are cleaned and cut at a word', () => {
  expect(cleanTitle('  Build\tthe   pricing section ')).toBe('Build the pricing section')
  expect(cleanTitle('a'.repeat(10) + ' ' + 'b'.repeat(70)).length).toBeLessThan(61)
  expect(barTitle('Make an HTML page of my setup. Then open it.')).toBe('Make an HTML page of my setup.')
  expect(barTitle('/better-prompt fix the login screen')).toBe('fix the login screen')
  expect(barTitle('')).toBe('Task')
})

test('the desktop task list fills the bar: items, advance, done and start', async ($, on) => {
  const sent = engine(on)
  await start($)
  await $.prompt.submit(typed('Make an HTML page of my Claude Code setup'))

  await call($, UPDATE_PLAN, { items: ITEMS, scope: 'first_task' })
  expect(sent.at(-1)?.id).toBe('task-1')
  expect(sent.at(-1)?.title).toBe('Make an HTML page of my Claude Code setup')
  expect(statuses(sent.at(-1))).toEqual(['active', 'pending', 'pending'])

  await call($, UPDATE_PLAN, { advance: true })
  expect(statuses(sent.at(-1))).toEqual(['done', 'active', 'pending'])

  await call($, UPDATE_PLAN, { done: [2], start: 3 })
  expect(statuses(sent.at(-1))).toEqual(['done', 'done', 'active'])

  // wrap_up checks the list off
  await call($, 'mcp__ccd_turn__wrap_up', { recap: 'Done.' })
  expect(statuses(sent.at(-1))).toEqual(['done', 'done', 'done'])
  expect(sent.every(bar => bar.id === 'task-1')).toBe(true)
})

test('the next task gets a bar of its own; a change to the same list keeps its bar', async ($, on) => {
  const sent = engine(on)
  await start($)
  await call($, UPDATE_PLAN, { items: ITEMS })
  // the plan changed: a step added, the others kept
  await call($, UPDATE_PLAN, { items: [...ITEMS, { content: 'Verify in the browser', status: 'pending' }], scope: 'continuation' })
  expect(sent.at(-1)?.id).toBe('task-1')
  expect(sent.at(-1)?.steps).toHaveLength(4)

  // an unrelated list is the next task
  await $.prompt.submit(typed('Fix the checkout bug'))
  await call($, UPDATE_PLAN, { items: [{ content: 'Reproduce the bug', status: 'in_progress' }], scope: 'new_task' })
  expect(sent.at(-1)?.id).toBe('task-2')
  expect(sent.at(-1)?.title).toBe('Fix the checkout bug')
})

test("the terminal's task tools fill the bar: create, update, delete", async ($, on) => {
  const sent = engine(on)
  await start($)
  await $.prompt.submit(typed('Add a settings screen'))
  await call($, 'TaskCreate', { subject: 'Design the screen', description: 'x' })
  await call($, 'TaskCreate', { subject: 'Wire the toggles', description: 'x' })
  await call($, 'TaskCreate', { subject: 'Write a test', description: 'x' })
  expect(sent.at(-1)?.steps.map(step => step.title)).toEqual(['Design the screen', 'Wire the toggles', 'Write a test'])

  await call($, 'TaskUpdate', { taskId: '1', status: 'completed' })
  await call($, 'TaskUpdate', { taskId: '2', status: 'in_progress' })
  expect(statuses(sent.at(-1))).toEqual(['done', 'active', 'pending'])

  await call($, 'TaskUpdate', { taskId: '3', status: 'deleted' })
  expect(sent.at(-1)?.steps).toHaveLength(2)
  expect(new Set(sent.map(bar => bar.id))).toEqual(new Set(['task-1']))
})

test('TodoWrite fills the bar as a whole list', async ($, on) => {
  const sent = engine(on)
  await start($)
  await call($, 'TodoWrite', {
    todos: [
      { content: 'Read the brief', status: 'completed', activeForm: 'Reading' },
      { content: 'Draft the page', status: 'in_progress', activeForm: 'Drafting' },
    ],
  })
  expect(statuses(sent.at(-1))).toEqual(['done', 'active'])
})

test("a subagent's list is left alone, and so is a refused call", async ($, on) => {
  const sent = engine(on)
  await start($)
  await call($, UPDATE_PLAN, { items: ITEMS, agentId: 'helper-1' })
  expect(sent).toHaveLength(0)
})

test('without plan-progress nothing breaks', async ($, on) => {
  engine(on, { hasBar: false })
  await start($)
  const ran = await call($, UPDATE_PLAN, { items: ITEMS })
  expect(ran.deny).toBeUndefined()
})

test('an open bar is sent again every few edits, so plan-progress never has to remind Claude', async ($, on) => {
  const sent = engine(on)
  await start($)
  await call($, UPDATE_PLAN, { items: ITEMS })
  expect(sent).toHaveLength(1)
  for (let n = 0; n < 4; n++) await call($, 'Edit', { file_path: '/a', old_string: 'x', new_string: 'y' })
  expect(sent).toHaveLength(2)
  expect(sent[1]).toEqual(sent[0])

  // a finished bar is left alone
  await call($, 'mcp__ccd_turn__wrap_up', { recap: 'Done.' })
  const before = sent.length
  for (let n = 0; n < 8; n++) await call($, 'Edit', { file_path: '/a', old_string: 'x', new_string: 'y' })
  expect(sent).toHaveLength(before)
})

test('moves on a list never sent are ignored', () => {
  expect(fromUpdatePlan([], { advance: true })).toEqual([])
  expect(fromUpdatePlan([], { recap: 'x' })).toBeNull()
})
