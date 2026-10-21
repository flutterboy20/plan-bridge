// plan-bridge: the plan-progress bar, filled from the task list Claude already
// keeps. In the desktop app that is its task list tool (update_plan, closed by
// wrap_up); in the terminal, TaskCreate and TaskUpdate, or TodoWrite. Each change
// is sent to plan-progress's own tool as the whole list, so Claude makes no
// extra calls and plan-progress draws the bar as usual.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptOrigin, Register } from 'claude-code'

import type { Bar, Step } from '../types'
import { allDone, barTitle, cleanTitle, fromTodoWrite, fromUpdatePlan, isNewList, statusOf } from './logic'

const BAR_TOOL = 'mcp__plan-progress__plan_progress'
const UPDATE_PLAN = 'mcp__ccd_turn__update_plan'
const WRAP_UP = 'mcp__ccd_turn__wrap_up'

const bar = atom({ plugin: 'plan-bridge', key: 'bar' } as const, null)
const made = atom({ plugin: 'plan-bridge', key: 'made' } as const, 0)
const title = atom({ plugin: 'plan-bridge', key: 'title' } as const, '')

// Said once per load when plan-progress is off or missing, then quiet.
let isWarned = false

// The person's own prompts name the bar: typed anywhere, or sent by a mod in their words.
const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk', 'slack-ping'])
const isPerson = (origin: PromptOrigin | undefined) =>
  origin === undefined ||
  PERSON_ORIGINS.has(origin.kind) ||
  (origin.kind === 'plugin' && (origin as { asUser?: boolean }).asUser === true)

async function send($: EngineInterface, shown: Bar) {
  if (shown.steps.length === 0) return
  editsSinceSend = 0
  try {
    await $.tool.call({
      tool: BAR_TOOL,
      id: shown.id,
      title: shown.title,
      kind: 'todo',
      stages: [{ name: 'Tasks', steps: shown.steps.map(step => ({ title: step.title, status: step.status })) }],
    } as never)
  } catch (err) {
    if (isWarned) return
    isWarned = true
    $.ui.log(`plan-bridge: no plan-progress bar to fill (${String(err)}). Turn plan-progress on in ⚙ Mods to see it.`)
  }
}

async function keep($: EngineInterface, next: Bar) {
  await update($, bar, () => next)
  await send($, next)
}

// A list for the bar: the next task gets a bar of its own, a change to the
// current one moves it.
async function show($: EngineInterface, steps: Step[], taskIds?: string[]) {
  const shown = await read($, bar)
  if (shown !== null && !isNewList(shown.steps, steps)) {
    await keep($, { ...shown, steps, taskIds: taskIds ?? shown.taskIds })

    return
  }
  const count = (await read($, made)) + 1
  await update($, made, () => count)
  await keep($, {
    id: `task-${count}`,
    title: (await read($, title)) || 'Task',
    steps,
    taskIds: taskIds ?? steps.map(() => ''),
  })
}

// plan-progress reminds Claude about a bar left unmoved for six edits; a bar this
// mod keeps moves with the task list, so it is sent again, unchanged, every few
// edits, and the reminder (a detour for Claude) never comes.
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const EDITS_BEFORE_RESEND = 4
let editsSinceSend = 0

export const register: Register = on => {
  on('prompt.submit', async ($, e, next) => {
    const entered = await next(e)
    if (entered.drop === undefined && e.command === undefined && e.isMeta !== true && isPerson(e.origin)) {
      await update($, title, () => barTitle(e.text))
    }

    return entered
  })

  // A /clear starts a new conversation: its first list gets a new bar.
  on('session.end', async ($, e, next) => {
    const ended = await next(e)
    if (e.reason === 'clear') await update($, bar, () => null)

    return ended
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    // a subagent's list is its own; plan-progress already draws its agent rows
    if (e.agentId !== undefined || ran.deny !== undefined || ran.isError === true) return ran
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    try {
      if (EDIT_TOOLS.has(tool)) {
        editsSinceSend += 1
        const shown = await read($, bar)
        if (editsSinceSend >= EDITS_BEFORE_RESEND && shown !== null && shown.steps.some(step => step.status !== 'done')) {
          await send($, shown)
        }
      } else if (tool === UPDATE_PLAN) {
        const shown = await read($, bar)
        const steps = fromUpdatePlan(shown?.steps ?? [], input)
        if (steps !== null) await show($, steps)
      } else if (tool === WRAP_UP) {
        // the turn's work is done: the list is checked off
        const shown = await read($, bar)
        if (shown !== null && shown.steps.some(step => step.status !== 'done')) {
          await keep($, { ...shown, steps: allDone(shown.steps) })
        }
      } else if (tool === 'TodoWrite') {
        const steps = fromTodoWrite(input)
        if (steps !== null) await show($, steps)
      } else if (tool === 'TaskCreate') {
        const created = (ran.result as { task?: { id?: unknown; subject?: unknown } } | undefined)?.task
        const step: Step = { title: cleanTitle(input.subject ?? created?.subject), status: 'pending' }
        if (step.title === '') return ran
        const shown = await read($, bar)
        const isFresh = shown === null || shown.steps.every(one => one.status === 'done')
        const steps = isFresh ? [step] : [...shown.steps, step]
        const taskIds = [...(isFresh ? [] : shown.taskIds), String(created?.id ?? '')]
        if (isFresh) await show($, steps, taskIds)
        else await keep($, { ...shown, steps, taskIds })
      } else if (tool === 'TaskUpdate') {
        const shown = await read($, bar)
        const at = shown?.taskIds.indexOf(String(input.taskId ?? '')) ?? -1
        if (shown === null || at < 0) return ran
        if (input.status === 'deleted') {
          await keep($, {
            ...shown,
            steps: shown.steps.filter((_, index) => index !== at),
            taskIds: shown.taskIds.filter((_, index) => index !== at),
          })
        } else {
          const steps = shown.steps.map((step, index) =>
            index === at
              ? {
                  title: typeof input.subject === 'string' ? cleanTitle(input.subject) || step.title : step.title,
                  status: input.status === undefined ? step.status : statusOf(input.status),
                }
              : step,
          )
          await keep($, { ...shown, steps })
        }
      }
    } catch (err) {
      $.ui.log(`plan-bridge: could not update the bar (${String(err)})`)
    }

    return ran
  })
}
