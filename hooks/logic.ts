// How each task-list tool's input changes the list the bar shows. Plain
// functions of the list and the input, so the hook only moves data around.

import type { Question, Step, StepStatus } from '../types'

const TITLE_MAX = 60
const BAR_TITLE_MAX = 48

export function cleanTitle(text: unknown, max = TITLE_MAX): string {
  const line = String(text ?? '')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (line.length <= max) return line
  const cut = line.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')

  return `${space > max / 2 ? cut.slice(0, space) : cut}…`
}

// A sentence that says what was done rather than what to do ("I ran
// /reload-plugins."), or that is too short to name a task.
const isAside = (sentence: string) =>
  /^\s*(i\s+(just\s+)?(ran|did|have|tried|restarted|reloaded)|ok(ay)?|thanks|done)\b/i.test(sentence) ||
  sentence.trim().split(/\s+/).length < 3

// The bar's title from the person's prompt: its first sentence that asks for
// something, short; the first sentence when none does.
export function barTitle(prompt: string): string {
  const sentences = prompt
    .replace(/^\/\S+\s*/, '')
    .split(/(?<=[.!?])\s|\n/)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence !== '')
  const pick = sentences.find(sentence => !isAside(sentence)) ?? sentences[0] ?? ''

  return cleanTitle(pick, BAR_TITLE_MAX) || 'Task'
}

export function statusOf(value: unknown): StepStatus {
  if (value === 'in_progress' || value === 'active') return 'active'
  if (value === 'completed' || value === 'done') return 'done'

  return 'pending'
}

// At most one active step: the first; the rest it would have made active wait.
export function oneActive(steps: readonly Step[]): Step[] {
  let isTaken = false

  return steps.map(step => {
    if (step.status !== 'active') return step
    if (isTaken) return { ...step, status: 'pending' }
    isTaken = true

    return step
  })
}

// The desktop app's task list tool (mcp__ccd_turn__update_plan): a whole list
// in `items`, or moves on the list it already sent.
export function fromUpdatePlan(steps: readonly Step[], input: Record<string, unknown>): Step[] | null {
  let next: Step[] = [...steps]
  let isChanged = false
  if (Array.isArray(input.items)) {
    next = input.items
      .map(raw => raw as { content?: unknown; status?: unknown })
      .map(item => ({ title: cleanTitle(item.content), status: statusOf(item.status) }))
      .filter(step => step.title !== '')
    isChanged = true
  }
  if (input.advance === true) {
    const at = next.findIndex(step => step.status === 'active')
    if (at >= 0) next[at] = { ...(next[at] as Step), status: 'done' }
    const after = next.findIndex((step, index) => index > at && step.status === 'pending')
    if (after >= 0) next[after] = { ...(next[after] as Step), status: 'active' }
    isChanged = true
  }
  if (Array.isArray(input.done)) {
    for (const n of input.done) {
      const at = Number(n) - 1
      if (next[at] !== undefined) next[at] = { ...(next[at] as Step), status: 'done' }
    }
    isChanged = true
  }
  if (typeof input.start === 'number' && next[input.start - 1] !== undefined) {
    next = next.map((step, index) =>
      index === (input.start as number) - 1
        ? { ...step, status: 'active' }
        : step.status === 'active'
          ? { ...step, status: 'pending' }
          : step,
    )
    isChanged = true
  }

  return isChanged ? oneActive(next) : null
}

// TodoWrite: always the whole list.
export function fromTodoWrite(input: Record<string, unknown>): Step[] | null {
  if (!Array.isArray(input.todos)) return null

  return oneActive(
    input.todos
      .map(raw => raw as { content?: unknown; status?: unknown })
      .map(todo => ({ title: cleanTitle(todo.content), status: statusOf(todo.status) }))
      .filter(step => step.title !== ''),
  )
}

// A list that shares no step with the one shown, or follows one fully done, is
// the next task and gets a bar of its own.
export function isNewList(shown: readonly Step[], next: readonly Step[]): boolean {
  if (shown.length === 0) return true
  if (shown.every(step => step.status === 'done')) return true
  const titles = new Set(shown.map(step => step.title.toLowerCase()))

  return !next.some(step => titles.has(step.title.toLowerCase()))
}

export const allDone = (steps: readonly Step[]): Step[] => steps.map(step => ({ ...step, status: 'done' }))

// wrap_up's question and its reply buttons, when the band can stand in for the
// desktop's box: null with no question, or with an app action (commit, create
// a PR) among the buttons, since only the box can run one.
export function wrapUpOffer(input: Record<string, unknown>): Question | null {
  const ask = cleanTitle(input.ask, 140)
  const actions = Array.isArray(input.actions) ? (input.actions as Record<string, unknown>[]) : []
  if (ask === '' || actions.length === 0) return null
  if (actions.some(one => typeof one !== 'object' || one === null || one.action !== undefined)) return null
  const replies = actions
    .map(one => {
      const label = cleanTitle(one.label, 32)
      const message = typeof one.message === 'string' && one.message.trim() !== '' ? one.message.trim() : label

      return { label, message }
    })
    .filter(one => one.label !== '')

  return replies.length === 0 ? null : { ask, replies }
}

// Elapsed time as a person reads it: 45s, 1m 12s, 1h 3m.
export function since(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

// Text cut to `room` cells with an ellipsis.
export function fit(text: string, room: number): string {
  if (room <= 0) return ''
  const points = [...text]

  return points.length <= room ? text : `${points.slice(0, Math.max(0, room - 1)).join('')}…`
}

// A model id as a person reads it: claude-haiku-4-5-20251001 is "haiku 4.5".
export function modelName(model: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?!\d)/.exec(model)
  if (m === null) return model.replace(/^claude-/, '')

  return `${m[1]} ${m[2]}${m[3] !== undefined ? `.${m[3]}` : ''}`
}

// A tool as a word: mcp__server__search is "search".
export const toolWord = (tool: string) => /^mcp__.+?__(.+)$/.exec(tool)?.[1] ?? tool

// How far along a list is, 0 to 1: each step done counts whole, the one at work half.
export function fraction(steps: readonly Step[]): number {
  if (steps.length === 0) return 0
  const done = steps.filter(step => step.status === 'done').length
  const active = steps.some(step => step.status === 'active') ? 0.5 : 0

  return Math.min(1, (done + active) / steps.length)
}

// A stable pseudo-random number in [0, 1) for a cell, so the dots stay put between draws.
export function hash(x: number, y: number, seed: number): number {
  let n = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0
  n = Math.imul(n ^ (n >>> 13), 1274126177)

  return ((n ^ (n >>> 16)) >>> 0) / 4294967296
}
