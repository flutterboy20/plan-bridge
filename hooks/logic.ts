// How each task-list tool's input changes the list the bar shows. Plain
// functions of the list and the input, so the hook only moves data around.

import type { Step, StepStatus } from '../types'

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

// The bar's title from the person's prompt: its first sentence, short.
export function barTitle(prompt: string): string {
  const first = prompt.replace(/^\/\S+\s*/, '').split(/(?<=[.!?])\s|\n/)[0] ?? ''

  return cleanTitle(first, BAR_TITLE_MAX) || 'Task'
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
