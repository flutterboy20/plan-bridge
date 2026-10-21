// plan-bridge: a progress bar above the prompt, filled from the task list Claude
// already keeps. In the desktop app that is its task list tool (update_plan,
// closed by wrap_up); in the terminal, TaskCreate and TaskUpdate, or TodoWrite.
// Claude makes no extra calls for it. Where plan-progress is installed, the list
// goes to plan-progress's own tool instead, and this mod draws nothing, so there
// is only ever one bar.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptOrigin, Register } from 'claude-code'

import type { Bar, Step, StepStatus } from '../types'
import {
  allDone,
  barTitle,
  cleanTitle,
  fit,
  fromTodoWrite,
  fromUpdatePlan,
  isNewList,
  since,
  statusOf,
  trackParts,
  trackSvg,
} from './logic'

const BAR_TOOL = 'mcp__plan-progress__plan_progress'
const UPDATE_PLAN = 'mcp__ccd_turn__update_plan'
const WRAP_UP = 'mcp__ccd_turn__wrap_up'

const GOLD = '#F2C46D'
const GREEN = '#3DD68C'
const SLATE = '#3A404A'
const MUTED = '#7D8590'
const COLORS: Record<StepStatus, string> = { done: GREEN, active: GOLD, pending: SLATE }

const bar = atom({ plugin: 'plan-bridge', key: 'bar' } as const, null)
const made = atom({ plugin: 'plan-bridge', key: 'made' } as const, 0)
const title = atom({ plugin: 'plan-bridge', key: 'title' } as const, '')

// The person's own prompts name the bar: typed anywhere, or sent by a mod in their words.
const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk', 'slack-ping'])
const isPerson = (origin: PromptOrigin | undefined) =>
  origin === undefined ||
  PERSON_ORIGINS.has(origin.kind) ||
  (origin.kind === 'plugin' && (origin as { asUser?: boolean }).asUser === true)

const isFinished = (steps: readonly Step[]) => steps.length > 0 && steps.every(step => step.status === 'done')

// The running clock on the bar: a redraw a second, only while a list this mod
// draws is under way.
let ticker: { cancel: () => void } | null = null
async function syncTicker($: EngineInterface) {
  const shown = await read($, bar)
  const isRunning = shown !== null && !shown.isFed && !shown.isHidden && shown.endedAt === null && shown.steps.length > 0
  if (isRunning && ticker === null) ticker = $.clock.every(1000, () => $.ui.invalidate('ui.render'))
  if (!isRunning && ticker !== null) {
    ticker.cancel()
    ticker = null
  }
}

const hasPlanProgress = async ($: EngineInterface) =>
  (await $.tool.list().catch(() => [])).some(tool => tool.name === BAR_TOOL)

// plan-progress reminds Claude about a bar left unmoved for six edits; a bar this
// mod feeds moves with the task list, so it is sent again, unchanged, every few
// edits, and the reminder (a detour for Claude) never comes.
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const EDITS_BEFORE_RESEND = 4
let editsSinceSend = 0

// Hands the list to plan-progress; false when it is not there to take it.
async function feed($: EngineInterface, shown: Bar): Promise<boolean> {
  if (shown.steps.length === 0) return true
  editsSinceSend = 0
  try {
    await $.tool.call({
      tool: BAR_TOOL,
      id: shown.id,
      title: shown.title,
      kind: 'todo',
      stages: [{ name: 'Tasks', steps: shown.steps.map(step => ({ title: step.title, status: step.status })) }],
    } as never)

    return true
  } catch {
    return false
  }
}

async function keep($: EngineInterface, next: Bar) {
  const now = await $.clock.now()
  const done = isFinished(next.steps)
  let kept: Bar = { ...next, endedAt: done ? (next.endedAt ?? now) : null }
  // plan-progress was turned off since: this mod draws the list from here on
  if (kept.isFed && !(await feed($, kept))) kept = { ...kept, isFed: false }
  await update($, bar, () => kept)
  await syncTicker($)
}

// A list for the bar: the next task gets a bar of its own, a change to the
// current one moves it.
async function show($: EngineInterface, steps: Step[], taskIds?: string[]) {
  const shown = await read($, bar)
  if (shown !== null && !isNewList(shown.steps, steps)) {
    await keep($, { ...shown, steps, taskIds: taskIds ?? shown.taskIds, isHidden: false })

    return
  }
  const count = (await read($, made)) + 1
  await update($, made, () => count)
  await keep($, {
    id: `task-${count}`,
    title: (await read($, title)) || 'Task',
    steps,
    taskIds: taskIds ?? steps.map(() => ''),
    startedAt: await $.clock.now(),
    endedAt: null,
    isFed: await hasPlanProgress($),
    isHidden: false,
  })
}

async function hide($: EngineInterface) {
  await update($, bar, now => (now === null ? now : { ...now, isHidden: true }))
  await syncTicker($)
}

export const register: Register = on => {
  // Reloaded mid-task: the clock starts again.
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await syncTicker($)

    return started
  })

  on('prompt.submit', async ($, e, next) => {
    const entered = await next(e)
    if (entered.drop === undefined && e.command === undefined && e.isMeta !== true && isPerson(e.origin)) {
      await update($, title, () => barTitle(e.text))
      // a finished bar steps aside for the next request
      const shown = await read($, bar)
      if (shown !== null && shown.endedAt !== null && !shown.isHidden) await hide($)
    }

    return entered
  })

  // A /clear starts a new conversation: its first list gets a new bar.
  on('session.end', async ($, e, next) => {
    const ended = await next(e)
    if (e.reason === 'clear') {
      await update($, bar, () => null)
      await syncTicker($)
    }

    return ended
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    // a subagent's list is its own
    if (e.agentId !== undefined || ran.deny !== undefined || ran.isError === true) return ran
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    try {
      if (EDIT_TOOLS.has(tool)) {
        editsSinceSend += 1
        const shown = await read($, bar)
        if (editsSinceSend >= EDITS_BEFORE_RESEND && shown !== null && shown.isFed && shown.endedAt === null) {
          await feed($, shown)
        }
      } else if (tool === UPDATE_PLAN) {
        const shown = await read($, bar)
        const steps = fromUpdatePlan(shown?.steps ?? [], input)
        if (steps !== null) await show($, steps)
      } else if (tool === WRAP_UP) {
        // the turn's work is done: the list is checked off
        const shown = await read($, bar)
        if (shown !== null && !isFinished(shown.steps)) await keep($, { ...shown, steps: allDone(shown.steps) })
      } else if (tool === 'TodoWrite') {
        const steps = fromTodoWrite(input)
        if (steps !== null) await show($, steps)
      } else if (tool === 'TaskCreate') {
        const created = (ran.result as { task?: { id?: unknown; subject?: unknown } } | undefined)?.task
        const step: Step = { title: cleanTitle(input.subject ?? created?.subject), status: 'pending' }
        if (step.title === '') return ran
        const shown = await read($, bar)
        const isFresh = shown === null || isFinished(shown.steps)
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

  // The bar, above the prompt and under whatever else is there.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    const shown = await read($, bar)
    if (shown === null || shown.isFed || shown.isHidden || shown.steps.length === 0 || e.props.hasSurvey) return below
    const table = $.ui.resolve(e)
    const { Box, Button, Text } = table
    const Svg = 'Svg' in table ? table.Svg : null
    const cols = Math.max(24, e.props.bodyColumns)
    const now = await $.clock.now()
    const total = shown.steps.length
    const done = shown.steps.filter(step => step.status === 'done').length
    const isDone = shown.endedAt !== null
    const percent = Math.round((done / total) * 100)
    const took = since((shown.endedAt ?? now) - shown.startedAt)
    const active = shown.steps.find(step => step.status === 'active') ?? shown.steps.find(step => step.status === 'pending')
    const after =
      active === undefined ? undefined : shown.steps.slice(shown.steps.indexOf(active) + 1).find(step => step.status !== 'done')

    // First row: state, title, then the count, percent and time, and ✕ at the end.
    const right = isDone ? `${done}/${total} · took ${took}` : `${done}/${total} · ${percent}% · ${took}`
    const titleRoom = Math.max(4, cols - right.length - 6)
    const shownTitle = fit(shown.title, titleRoom)
    const head = (
      <Box flexDirection="row">
        <Text color={isDone ? GREEN : GOLD}>{isDone ? '✓ ' : '▶ '}</Text>
        <Text bold>{shownTitle}</Text>
        <Text>{' '.repeat(Math.max(1, titleRoom - [...shownTitle].length + 1))}</Text>
        <Text color={MUTED}>{right}</Text>
        <Text> </Text>
        <Button key="close-bar" plain dimColor label="✕" onPress={() => hide($)} />
      </Box>
    )

    // Second row: one segment a step, green done, gold the one at work, dim the rest.
    const track =
      e.surface !== 'terminal' && Svg !== null ? (
        <Svg source={trackSvg(shown.steps, COLORS)} alt={`${done} of ${total} steps done`} height={10} />
      ) : (
        <Box flexDirection="row">
          {trackParts(shown.steps, cols).map(([cells, kind], index) => (
            <Text key={`seg:${index}`} color={COLORS[kind]}>
              {cells}
            </Text>
          ))}
        </Box>
      )

    // Third row: what is happening now and what comes next, or how it ended.
    const nowRoom = Math.max(8, Math.floor(cols * 0.6))
    const line = isDone ? (
      <Text color={GREEN}>All done · took {took}</Text>
    ) : (
      <Box flexDirection="row">
        <Text color={GOLD}>{fit(active?.title ?? 'Working', nowRoom)}</Text>
        {after !== undefined && <Text color={MUTED}>{fit(`  then ${after.title}`, Math.max(0, cols - nowRoom))}</Text>}
      </Box>
    )

    return (
      <Box flexDirection="column">
        {below}
        <Box flexDirection="column" marginTop={1}>
          {head}
          {track}
          {line}
        </Box>
      </Box>
    )
  })
}
