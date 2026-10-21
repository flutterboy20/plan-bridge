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

// The terminal's track: one run of cells per step, a space between, filling
// `width` cells exactly. Each part is [cells, kind].
export function trackParts(steps: readonly Step[], width: number): [string, StepStatus][] {
  const count = steps.length
  if (count === 0 || width <= 0) return []
  const gaps = width >= count * 3 ? count - 1 : 0
  const room = width - gaps
  const parts: [string, StepStatus][] = []
  let used = 0
  steps.forEach((step, index) => {
    const end = Math.round(((index + 1) * room) / count)
    const cells = Math.max(1, end - used)
    used = end
    parts.push([(step.status === 'pending' ? '─' : '━').repeat(cells), step.status])
    if (gaps > 0 && index < count - 1) parts.push([' ', 'pending'])
  })

  return parts
}

// The desktop's track: the same segments, drawn as one SVG that stretches to its slot.
export function trackSvg(steps: readonly Step[], colors: Record<StepStatus, string>): string {
  const width = 1000
  const gap = steps.length > 1 ? 6 : 0
  const each = (width - gap * (steps.length - 1)) / Math.max(1, steps.length)
  const rects = steps
    .map((step, index) => {
      const x = (each + gap) * index
      const y = step.status === 'pending' ? 3 : 2
      const tall = step.status === 'pending' ? 4 : 6

      return `<rect x="${x.toFixed(1)}" y="${y}" width="${each.toFixed(1)}" height="${tall}" fill="${colors[step.status]}"/>`
    })
    .join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="10" viewBox="0 0 ${width} 10" preserveAspectRatio="none">${rects}</svg>`
}
