// plan-bridge: progress bars above the prompt, filled from the task list Claude
// already keeps, with a row for each subagent at work. In the desktop app the
// list is its task list tool (update_plan, closed by wrap_up); in the terminal,
// TaskCreate and TaskUpdate, or TodoWrite. Claude makes no extra calls for it.
// A finished bar stays until it is closed with ✕; the next task gets a bar of
// its own under it. Where plan-progress is installed, each list goes to
// plan-progress's own tool instead, and this mod draws nothing, so there is only
// ever one bar per task.
//
// The desktop hides the band while its next-step box (wrap_up's question) is
// up, so the question and its reply buttons move into the band, under the bars
// or alone, and the box is left out; a press puts the reply in the prompt to
// send. The desktop draws the box from the call as recorded, so the question
// comes off as the call streams (turn.step), not only when it runs. A question
// with an app action (commit, create a PR) keeps its box: only the box runs one.
//
// Every change goes through one update of the whole list: hooks run side by
// side (three agents start at once), and update retries a write that another
// one beat, so no change is lost.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptOrigin, Register, TurnStepChunk } from 'claude-code'

import type { AgentRun, AgentState, Bar, BarState, Question, Step } from '../types'
import {
  PALETTE,
  STRIP_GAP,
  STRIP_H,
  TRACK_H,
  agentSvg,
  barFraction,
  moreSvg,
  shownAgents,
  textWidth,
  trackCells,
  trackSvg,
} from './draw'
import {
  allDone,
  barTitle,
  cleanTitle,
  fit,
  fromTodoWrite,
  fromUpdatePlan,
  isNewList,
  modelName,
  since,
  statusOf,
  toolWord,
  wrapUpOffer,
} from './logic'

const BAR_TOOL = 'mcp__plan-progress__plan_progress'
const UPDATE_PLAN = 'mcp__ccd_turn__update_plan'
const WRAP_UP = 'mcp__ccd_turn__wrap_up'
const GLYPH: Record<BarState, string> = { running: '●', needs: '?', error: '!', done: '✓' }
// Bars kept at most; past that the oldest finished one goes.
const MAX_BARS = 3
// Agent rows one bar shows at most; the rest fold into one "+N more" line.
const MAX_AGENT_ROWS = 4
// Main-loop tool calls failing in a row before the bar turns red.
const FAILS_FOR_ERROR = 3

const bars = atom({ plugin: 'plan-bridge', key: 'bars' } as const, [])
const made = atom({ plugin: 'plan-bridge', key: 'made' } as const, 0)
const title = atom({ plugin: 'plan-bridge', key: 'title' } as const, '')
const question = atom({ plugin: 'plan-bridge', key: 'question' } as const, null)

// The person's own prompts name the bar: typed anywhere, or sent by a mod in their words.
const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk', 'slack-ping'])
const isPerson = (origin: PromptOrigin | undefined) =>
  origin === undefined ||
  PERSON_ORIGINS.has(origin.kind) ||
  (origin.kind === 'plugin' && (origin as { asUser?: boolean }).asUser === true)

const isLive = (agent: AgentRun) => agent.state === 'running' || agent.state === 'needs'
const stepsFinished = (steps: readonly Step[]) => steps.length > 0 && steps.every(step => step.status === 'done')
const isAtWork = (one: Bar) => !one.isHidden && (one.state !== 'done' || one.agents.some(isLive))

// The bar at work: the latest one shown that is not finished.
function activeAt(list: readonly Bar[]): number {
  for (let at = list.length - 1; at >= 0; at--) {
    const one = list[at] as Bar
    if (!one.isHidden && one.state !== 'done') return at
  }

  return -1
}

// A bar is done once its steps are and no agent is still at work; a step
// reopened, or an agent started, brings it back.
function settle(one: Bar, now: number): Bar {
  const isAllDone = stepsFinished(one.steps) && !one.agents.some(isLive)
  if (isAllDone && one.state !== 'done') return { ...one, state: 'done', note: '', endedAt: one.endedAt ?? now }
  if (!isAllDone && one.state === 'done' && (one.steps.length > 0 || one.agents.some(isLive))) {
    return { ...one, state: 'running', endedAt: null }
  }

  return one
}

// Closed bars go; past MAX_BARS the oldest finished ones go, then the oldest.
function trim(list: readonly Bar[]): Bar[] {
  const kept = list.filter(one => !one.isHidden)
  while (kept.length > MAX_BARS) {
    const at = kept.findIndex(one => one.state === 'done')
    kept.splice(at >= 0 ? at : 0, 1)
  }

  return kept
}

let failsInRow = 0

// What the band was last asked to draw, and how it went, for /plan-bridge debug.
let lastDraw = { at: 0, what: 'not drawn since the mod loaded' }

// The running clock: a redraw a second while a bar is at work, and now and
// then a look at the engine's agent list for an end that never reached the mod.
let ticker: { cancel: () => void } | null = null
let ticks = 0
function syncTicker($: EngineInterface, list: readonly Bar[]) {
  const isRunning = list.some(one => !one.isFed && isAtWork(one))
  if (isRunning && ticker === null) {
    ticker = $.clock.every(1000, () => {
      $.ui.invalidate('ui.render')
      ticks += 1
      if (ticks % 5 === 0) void settleAgents($).catch(() => undefined)
    })
  }
  if (!isRunning && ticker !== null) {
    ticker.cancel()
    ticker = null
  }
}

// One change to the list of bars, applied atomically, every bar settled after.
async function change($: EngineInterface, fn: (list: Bar[], now: number) => Bar[]): Promise<Bar[]> {
  const now = await $.clock.now()
  const next = await update($, bars, list => trim(fn([...list], now).map(one => settle(one, now))))
  syncTicker($, next)

  return next
}

// Changes the bar at `at`, if there is one.
const replaceAt = (list: Bar[], at: number, fn: (one: Bar) => Bar): Bar[] =>
  at < 0 ? list : list.map((one, index) => (index === at ? fn(one) : one))

const hasPlanProgress = async ($: EngineInterface) =>
  (await $.tool.list().catch(() => [])).some(tool => tool.name === BAR_TOOL)

// plan-progress reminds Claude about a bar left unmoved for six edits; a bar this
// mod feeds moves with the task list, so it is sent again, unchanged, every few
// edits, and the reminder (a detour for Claude) never comes.
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const EDITS_BEFORE_RESEND = 4
let editsSinceSend = 0

// Hands a list to plan-progress; false when it is not there to take it.
async function feed($: EngineInterface, one: Bar): Promise<boolean> {
  if (one.steps.length === 0) return true
  editsSinceSend = 0
  try {
    await $.tool.call({
      tool: BAR_TOOL,
      id: one.id,
      title: one.title,
      kind: 'todo',
      stages: [{ name: 'Tasks', steps: one.steps.map(step => ({ title: step.title, status: step.status })) }],
    } as never)

    return true
  } catch {
    return false
  }
}

// After a list changed: plan-progress gets it, or, gone since, this mod draws it from here on.
async function feedBar($: EngineInterface, id: string) {
  const one = (await read($, bars)).find(bar => bar.id === id)
  if (one === undefined || !one.isFed || (await feed($, one))) return
  await change($, list => list.map(bar => (bar.id === id ? { ...bar, isFed: false } : bar)))
}

// A new bar, ready in case the change needs one: its id, title and start are
// taken here, since the change itself cannot wait on anything.
async function fresh($: EngineInterface, steps: Step[], taskIds: string[], agents: AgentRun[] = []): Promise<Bar> {
  const count = await update($, made, n => n + 1)

  return {
    id: `task-${count}`,
    title: (await read($, title)) || 'Task',
    steps,
    taskIds,
    startedAt: await $.clock.now(),
    endedAt: null,
    state: 'running',
    note: '',
    agents,
    isFed: steps.length > 0 && (await hasPlanProgress($)),
    isHidden: false,
  }
}

// A whole list for the bar at work: a change to its list moves it (a bar that so
// far tracked only agents takes the list on); the next task gets a bar of its own.
async function show($: EngineInterface, steps: Step[], taskIds?: string[]) {
  const spare = await fresh($, steps, taskIds ?? steps.map(() => ''))
  let id = spare.id
  await change($, list => {
    const at = activeAt(list)
    const current = list[at]
    if (current !== undefined && (current.steps.length === 0 || !isNewList(current.steps, steps))) {
      id = current.id

      return replaceAt(list, at, one => ({ ...one, steps, taskIds: taskIds ?? one.taskIds }))
    }

    return [...list, spare]
  })
  await feedBar($, id)
}

async function hide($: EngineInterface, id: string) {
  await change($, list => list.map(one => (one.id === id ? { ...one, isHidden: true } : one)))
}

async function setState($: EngineInterface, state: BarState, note: string) {
  await change($, list => replaceAt(list, activeAt(list), one => ({ ...one, state, note })))
}

// Back to work once what it waited on or failed at has passed.
async function clearState($: EngineInterface, from: BarState) {
  await change($, list =>
    replaceAt(list, activeAt(list), one => (one.state === from ? { ...one, state: 'running', note: '' } : one)),
  )
}

// A subagent joins the bar at work, or a bar of its own when none is.
async function addAgent($: EngineInterface, run: AgentRun) {
  const spare = await fresh($, [], [], [run])
  await change($, list => {
    const at = activeAt(list)
    if (at < 0) return [...list, spare]

    return replaceAt(list, at, one => ({ ...one, agents: [...one.agents.filter(a => a.id !== run.id), run] }))
  })
}

async function editAgent($: EngineInterface, agentId: string, fn: (agent: AgentRun) => AgentRun) {
  const list = await read($, bars)
  if (!list.some(one => one.agents.some(a => a.id === agentId))) return
  await change($, latest =>
    latest.map(one =>
      one.agents.some(a => a.id === agentId) ? { ...one, agents: one.agents.map(a => (a.id === agentId ? fn(a) : a)) } : one,
    ),
  )
}

async function endAgent($: EngineInterface, agentId: string, state: AgentState, word: string) {
  const now = await $.clock.now()
  await editAgent($, agentId, a => (isLive(a) ? { ...a, state, tool: word, endedAt: now } : a))
}

// Ends that never arrived (an agent killed, a finish missed) are read off the
// engine's own agent list.
const ENDED: Partial<Record<string, AgentState>> = { completed: 'done', idle: 'done', failed: 'failed', killed: 'failed' }
async function settleAgents($: EngineInterface) {
  const live = (await read($, bars)).flatMap(one => one.agents.filter(isLive))
  if (live.length === 0) return
  const rows = await $.agent.list().catch(() => null)
  if (rows === null) return
  for (const agent of live) {
    const state = ENDED[rows.find(row => row.id === agent.id)?.status ?? '']
    if (state !== undefined) await endAgent($, agent.id, state, state === 'done' ? 'Done' : 'Failed')
  }
}

// The wrap_up question last taken off a call as it streamed, for the band to
// show once that call runs (a turn makes one wrap_up call).
let streamed: Question | null = null

// wrap_up's arguments, as streamed pieces, with the question and its buttons
// left out when the band can carry them; as they came otherwise.
function withoutQuestion(held: TurnStepChunk[]): TurnStepChunk[] {
  const first = held[0]
  if (first === undefined || first.kind !== 'input') return held
  let input: Record<string, unknown>
  try {
    input = JSON.parse(held.map(chunk => (chunk.kind === 'input' ? chunk.json : '')).join('')) as Record<string, unknown>
  } catch {
    return held
  }
  const offer = wrapUpOffer(input)
  if (offer === null) return held
  streamed = offer
  const { ask: _ask, actions: _actions, blocked: _blocked, ...rest } = input

  return [{ kind: 'input', index: first.index, json: JSON.stringify(rest) }]
}

export const register: Register = on => {
  // Reloaded mid-task: the clock starts again.
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'plan-bridge',
      description: 'plan-bridge: "/plan-bridge debug" says what the bar above the prompt last drew, and why',
    })
    const started = await next(e)
    syncTicker($, await read($, bars))

    return started
  })

  on('command.run', { command: 'plan-bridge' }, async ($, e) => {
    try {
      const now = await $.clock.now()
      const list = await read($, bars)
      const asked = await read($, question)
      const rows = list.map(
        one =>
          `${one.id} "${one.title}": ${one.state}, ${one.steps.length} steps, ${one.agents.length} agents${one.isHidden ? ', closed' : ''}${one.isFed ? ', handed to plan-progress' : ''}`,
      )

      return {
        text: [
          `Last drawn ${lastDraw.at === 0 ? 'never' : `${since(now - lastDraw.at)} ago`}: ${lastDraw.what}`,
          rows.length === 0 ? 'No bars kept.' : `Bars kept (${rows.length}):`,
          ...rows,
          asked === null ? '' : `Question shown: "${asked.ask}" (${asked.replies.length} replies)`,
          e.args.trim() === '' ? 'Use "/plan-bridge debug" for this report.' : '',
        ]
          .filter(Boolean)
          .join('\n'),
      }
    } catch (err) {
      return { text: `plan-bridge could not report: ${String(err)}` }
    }
  })

  on('prompt.submit', async ($, e, next) => {
    const entered = await next(e)
    if (entered.drop === undefined && e.command === undefined && e.isMeta !== true && isPerson(e.origin)) {
      await update($, title, () => barTitle(e.text))
      failsInRow = 0
      // a bar that waited on the person has its answer, and so has the last turn's question
      await update($, question, () => null)
      await change($, list =>
        replaceAt(list, activeAt(list), one =>
          one.state === 'needs' || one.state === 'error' ? { ...one, state: 'running', note: '' } : one,
        ),
      )
    }

    return entered
  })

  // A /clear starts a new conversation, with no bars.
  on('session.end', async ($, e, next) => {
    const ended = await next(e)
    if (e.reason === 'clear') {
      await change($, () => [])
      await update($, question, () => null)
    }

    return ended
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny !== undefined || started.agentId === undefined) return started
    await addAgent($, {
      id: started.agentId,
      title: cleanTitle(e.description || e.subagentType, 60) || 'Agent',
      model: started.model,
      effort: '',
      tool: 'Starting',
      state: 'running',
      startedAt: await $.clock.now(),
      endedAt: null,
      isNested: e.parentAgentId !== undefined,
    })

    return started
  })

  // An agent's first request says what it runs on: its model and effort. On the
  // main loop, wrap_up's question comes off its call as the call streams: the
  // desktop draws its box from the call as recorded, and the box hides the band.
  on('turn.step', async function* ($, e, next) {
    const agentId = e.agentId
    if (agentId !== undefined) {
      const effort = e.effort === undefined ? '' : String(e.effort)
      await editAgent($, agentId, a => (a.model === e.model && a.effort === effort ? a : { ...a, model: e.model, effort }))

      return yield* next(e)
    }
    const stream = next(e)
    let wrapAt = -1
    let held: TurnStepChunk[] = []
    for await (const chunk of stream) {
      if (chunk.kind === 'tool' && chunk.name === WRAP_UP) {
        wrapAt = chunk.index
      } else if (chunk.kind === 'input' && chunk.index === wrapAt) {
        held.push(chunk)
        continue
      }
      // the call's arguments are whole once another chunk comes: they go on, rewritten
      if (held.length > 0) {
        yield* withoutQuestion(held)
        held = []
      }
      yield chunk
    }
    if (held.length > 0) yield* withoutQuestion(held)

    return await stream.result
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) {
      const isFailed = e.reason !== 'answer'
      await endAgent($, e.agentId, isFailed ? 'failed' : 'done', e.reason === 'aborted' ? 'Stopped' : isFailed ? 'Failed' : 'Done')

      return done
    }
    if (e.reason === 'aborted') {
      await setState($, 'error', 'Stopped')

      return done
    }
    // a bar of agents alone is done when the turn is and they are
    await change($, (list, now) =>
      replaceAt(list, activeAt(list), one =>
        one.steps.length === 0 && !one.agents.some(isLive) ? { ...one, state: 'done', endedAt: one.endedAt ?? now } : one,
      ),
    )

    return done
  })

  // A permission dialog in front of the person: the agent's row, or the bar, waits.
  on('classic.PermissionRequest', async ($, e, next) => {
    const agentId = e.agent_id
    if (agentId) await editAgent($, agentId, a => (isLive(a) ? { ...a, state: 'needs' } : a))
    else await setState($, 'needs', 'Needs your OK')
    const answer = await next(e)
    // a settings hook answered it: no dialog was shown after all
    if (answer.decision !== undefined) {
      if (agentId) await editAgent($, agentId, a => (a.state === 'needs' ? { ...a, state: 'running' } : a))
      else await clearState($, 'needs')
    }

    return answer
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const agentId = e.agentId
    // a subagent's call: its row names the tool it is on
    if (agentId !== undefined) {
      await editAgent($, agentId, a => (isLive(a) ? { ...a, tool, state: a.state === 'needs' ? 'needs' : 'running' } : a))
      const ran = await next(e)
      await editAgent($, agentId, a => (a.state === 'needs' ? { ...a, state: 'running' } : a))

      return ran
    }
    if (tool === 'AskUserQuestion') await setState($, 'needs', 'Claude has a question')
    // wrap_up's question goes in the band, and the box is left out
    let sent = e
    if (tool === WRAP_UP) {
      // taken off as it streamed; else (a call not streamed) taken off here
      const here = wrapUpOffer(e as unknown as Record<string, unknown>)
      if (here !== null) {
        const { ask: _ask, actions: _actions, blocked: _blocked, ...rest } = e as unknown as Record<string, unknown>
        sent = rest as unknown as typeof e
      }
      const offer = here ?? streamed
      streamed = null
      if (offer !== null) await update($, question, () => offer)
    }
    const ran = await next(sent)
    // the call went ahead: a question was answered, a permission it waited on given
    await clearState($, 'needs')
    if (ran.deny !== undefined || ran.isError === true) {
      if (ran.isError === true) failsInRow += 1
      if (failsInRow >= FAILS_FOR_ERROR) await setState($, 'error', 'A step keeps failing')

      return ran
    }
    if (failsInRow > 0) {
      failsInRow = 0
      await clearState($, 'error')
    }
    const input = e as unknown as Record<string, unknown>
    try {
      if (EDIT_TOOLS.has(tool)) {
        editsSinceSend += 1
        const list = await read($, bars)
        const current = list[activeAt(list)]
        if (editsSinceSend >= EDITS_BEFORE_RESEND && current !== undefined && current.isFed) await feed($, current)
      } else if (tool === UPDATE_PLAN) {
        const list = await read($, bars)
        const steps = fromUpdatePlan(list[activeAt(list)]?.steps ?? [], input)
        if (steps !== null) await show($, steps)
      } else if (tool === WRAP_UP) {
        // the turn's work is done: the list is checked off
        const list = await change($, latest =>
          replaceAt(latest, activeAt(latest), one => (one.steps.length > 0 ? { ...one, steps: allDone(one.steps) } : one)),
        )
        const last = list.at(-1)
        if (last !== undefined) await feedBar($, last.id)
      } else if (tool === 'TodoWrite') {
        const steps = fromTodoWrite(input)
        if (steps !== null) await show($, steps)
      } else if (tool === 'TaskCreate') {
        const created = (ran.result as { task?: { id?: unknown; subject?: unknown } } | undefined)?.task
        const step: Step = { title: cleanTitle(input.subject ?? created?.subject), status: 'pending' }
        if (step.title === '') return ran
        const taskId = String(created?.id ?? '')
        const spare = await fresh($, [step], [taskId])
        let id = spare.id
        await change($, list => {
          const at = activeAt(list)
          const current = list[at]
          if (current === undefined) return [...list, spare]
          id = current.id

          return replaceAt(list, at, one => ({ ...one, steps: [...one.steps, step], taskIds: [...one.taskIds, taskId] }))
        })
        await feedBar($, id)
      } else if (tool === 'TaskUpdate') {
        const taskId = String(input.taskId ?? '')
        let id = ''
        await change($, list => {
          let at = -1
          for (let index = list.length - 1; index >= 0 && at < 0; index--) if (list[index]?.taskIds.includes(taskId)) at = index
          if (at < 0) return list
          id = list[at]?.id ?? ''

          return replaceAt(list, at, one => {
            const step = one.taskIds.indexOf(taskId)
            if (input.status === 'deleted') {
              return {
                ...one,
                steps: one.steps.filter((_, index) => index !== step),
                taskIds: one.taskIds.filter((_, index) => index !== step),
              }
            }

            return {
              ...one,
              steps: one.steps.map((old, index) =>
                index === step
                  ? {
                      title: typeof input.subject === 'string' ? cleanTitle(input.subject) || old.title : old.title,
                      status: input.status === undefined ? old.status : statusOf(input.status),
                    }
                  : old,
              ),
            }
          })
        })
        if (id !== '') await feedBar($, id)
      }
    } catch (err) {
      $.ui.log(`plan-bridge: could not update the bar (${String(err)})`)
    }

    return ran
  })

  // The bars, above the prompt and over whatever else is there.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    const note = `${e.surface} · working ${String(e.props.isWorking)} · ${String(e.props.bodyColumns)} columns · ${String(e.props.maxRows)} rows · survey ${String(e.props.hasSurvey)}`
    const draw = async () => {
      // the terminal's survey takes the number keys and the band's room; the
      // desktop draws its survey apart, so the bars stay there
      if (e.props.hasSurvey && e.surface === 'terminal') return below
      const list = (await read($, bars)).filter(one => !one.isFed && !one.isHidden && (one.steps.length > 0 || one.agents.length > 0))
      const asked = await read($, question)
      if (list.length === 0 && asked === null) return below
      const table = $.ui.resolve(e)
      const { Box, Button, Text } = table
      // pictures where the surface draws them, colored cells in the terminal
      const Svg = e.surface !== 'terminal' && 'Svg' in table ? table.Svg : null
      const Raster = e.surface === 'terminal' && 'Raster' in table ? table.Raster : null
      const cols = Math.max(30, Number(e.props.bodyColumns) || 100)
      const now = await $.clock.now()
      // the rows the band may take, shared out: each bar its head line, the rest to agent rows
      const room = Math.max(list.length, (e.props.maxRows || 12) - 2)
      const budget = Math.max(1, Math.min(MAX_AGENT_ROWS, Math.floor(room / list.length) - 1))
      const total = Math.max(360, cols * 8)
      const titleW = Math.min(Math.round(total * 0.28), Math.round(Math.max(...list.map(one => textWidth(one.title)))) + 6)
      const trackW = Math.max(160, Math.min(1400, total - titleW - 110))
      const titleCols = Math.min(Math.floor(cols * 0.3), Math.max(...list.map(one => [...one.title].length)))
      const trackCols = Math.max(10, cols - titleCols - 12)

      const drawBar = (one: Bar) => {
        const color = PALETTE[one.state]
        const percent = `${Math.round(barFraction(one) * 100)}%`.padStart(4)
        const { shown: rows, hidden } = shownAgents(one.agents, budget)
        const close = <Button key={`close:${one.id}`} plain dimColor label="✕" onPress={() => hide($, one.id)} />
        const alt = `${one.title}: ${one.state === 'done' ? `done in ${since((one.endedAt ?? now) - one.startedAt)}` : percent.trim()}`
        if (Svg !== null) {
          // the desktop: pictures for the track and the agent rows, all one width, pinned to the right
          return (
            <Box key={`bar:${one.id}`} flexDirection="row" alignItems="flex-start" gap={1}>
              <Text color={color}>{GLYPH[one.state]}</Text>
              <Text wrap="truncate">{one.title}</Text>
              <Box flexGrow={1} />
              <Box flexDirection="column" flexShrink={0}>
                <Svg source={trackSvg(one, trackW, now)} alt={alt} width={trackW} height={TRACK_H} />
                {rows.map((agent, index) => (
                  <Svg
                    key={`agent:${agent.id}`}
                    source={agentSvg(agent, one.agents.indexOf(agent) + 1, trackW, now, index === 0 ? STRIP_GAP + 1 : STRIP_GAP)}
                    alt={`${agent.title}: ${agent.state}, ${since((agent.endedAt ?? now) - agent.startedAt)}`}
                    width={trackW}
                    height={STRIP_H + (index === 0 ? STRIP_GAP + 1 : STRIP_GAP)}
                  />
                ))}
                {hidden.length > 0 && (
                  <Svg source={moreSvg(hidden, trackW, STRIP_GAP)} alt={`${hidden.length} more agents`} width={trackW} height={STRIP_H + STRIP_GAP} />
                )}
              </Box>
              <Text dimColor>{percent}</Text>
              {close}
            </Box>
          )
        }
        // the terminal: the track as a row of colored cells, the agents as lines under it
        const shownTitle = fit(one.title, titleCols)
        const head = (
          <Box flexDirection="row">
            <Text color={color}>{GLYPH[one.state]} </Text>
            <Text bold>{shownTitle}</Text>
            <Text>{' '.repeat(Math.max(1, titleCols - [...shownTitle].length + 1))}</Text>
            {Raster !== null ? (
              <Raster key={`track:${one.id}`} columns={trackCols} rows={1} cells={trackCells(one, trackCols, now)} />
            ) : (
              <Text color={color}>{'━'.repeat(Math.round(barFraction(one) * trackCols))}</Text>
            )}
            <Text dimColor>{percent} </Text>
            {close}
          </Box>
        )
        const agentLines = rows.map(agent => {
          const live = isLive(agent)
          const time = since((agent.endedAt ?? now) - agent.startedAt)
          const word = agent.state === 'needs' ? 'Needs approval' : live ? toolWord(agent.tool) : agent.state === 'failed' ? agent.tool : ''
          const spec = [agent.model === '' ? '' : modelName(agent.model), agent.effort].filter(Boolean).join(' · ')
          const lead = `  ⧉ ${String(one.agents.indexOf(agent) + 1).padStart(2)} `
          const right = `${word === '' ? '' : `${fit(word, 16)}  `}${time.padStart(6)}`
          const space = Math.max(6, cols - lead.length - 2 - right.length - 2)
          const name = fit(`${agent.isNested ? '↳ ' : ''}${agent.title}`, space)
          const specShown = spec === '' ? '' : fit(` (${spec})`, Math.max(0, space - [...name].length))
          const pad = Math.max(1, space - [...name].length - [...specShown].length + 1)

          return (
            <Box key={`agent:${agent.id}`} flexDirection="row">
              <Text dimColor>{lead}</Text>
              <Text color={PALETTE[agent.state]}>● </Text>
              <Text bold={live}>{name}</Text>
              <Text dimColor>{specShown}</Text>
              <Text>{' '.repeat(pad)}</Text>
              {word !== '' && <Text color={PALETTE[agent.state]}>{fit(word, 16)}  </Text>}
              <Text dimColor>{time.padStart(6)}</Text>
            </Box>
          )
        })

        return (
          <Box key={`bar:${one.id}`} flexDirection="column">
            {head}
            {agentLines}
            {hidden.length > 0 && (
              <Text dimColor>
                {`  ⧉ +${hidden.length}  ${hidden.length} more agent${hidden.length === 1 ? '' : 's'} · ${hidden.filter(a => !isLive(a)).length} done`}
              </Text>
            )}
          </Box>
        )
      }

      // the next-step question, with a button per reply that puts it in the prompt
      const askRow =
        asked === null ? null : (
          <Box key="ask" flexDirection="row" flexWrap="wrap" alignItems="center" gap={1}>
            <Text color={PALETTE.needs}>?</Text>
            <Text>{asked.ask}</Text>
            {asked.replies.map((reply, index) => (
              <Button
                key={`reply:${index}`}
                label={reply.label}
                dimColor={index > 0 ? true : undefined}
                onPress={() => void $.prompt.fill({ text: reply.message })}
              />
            ))}
          </Box>
        )

      return (
        <Box flexDirection="column">
          {below}
          <Box flexDirection="column" marginTop={1} gap={1}>
            {list.map(drawBar)}
            {askRow}
          </Box>
        </Box>
      )
    }
    // a drawing that fails leaves the band as it was below, and says why on /plan-bridge debug
    try {
      const drawn = await draw()
      lastDraw = { at: await $.clock.now(), what: `${note} · ${drawn === below ? 'no bar drawn' : 'bars drawn'}` }

      return drawn
    } catch (err) {
      lastDraw = { at: await $.clock.now(), what: `${note} · drawing failed: ${String(err)}` }

      return below
    }
  })
}
