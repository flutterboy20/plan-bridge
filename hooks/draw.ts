// The pictures: the desktop's track and agent rows as SVG, the terminal's track
// as a row of colored cells. Pure functions of the bar and the time, so a draw
// changes nothing; motion is CSS inside the SVG, its phase taken from the clock
// so a picture rebuilt each second carries on where the last one was.

import type { AgentRun, AgentState, Bar, BarState } from '../types'
import { fraction, hash, modelName, since, toolWord } from './logic'

export const PALETTE: Record<BarState | AgentState, string> = {
  running: '#9D8CFF',
  needs: '#E3B341',
  error: '#F06A6A',
  failed: '#F06A6A',
  done: '#3DD68C',
}
// Text on a pill of that colour.
const PILL_INK: Record<BarState, string> = { running: '#FFFFFF', needs: '#1A1405', error: '#FFFFFF', done: '#06210F' }
const FONT = "'Anthropic Sans',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif"

export const TRACK_H = 22
export const STRIP_H = 18
export const STRIP_GAP = 4

const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
// About how wide text is at 11.5px in the desktop's sans face.
export const textWidth = (text: string) => [...text].length * 6.5

function fitText(text: string, room: number): string {
  if (textWidth(text) <= room) return text
  const points = [...text]
  while (points.length > 1 && textWidth(`${points.join('')}…`) > room) points.pop()

  return `${points.join('').trimEnd()}…`
}

// Where an animation of `period` seconds stands at `now`, as a negative delay:
// a picture rebuilt on the next draw picks up mid-cycle instead of restarting.
const phase = (now: number, period: number, offset = 0) => `-${(((now / 1000 + offset) % period) + period) % period}s`

function style(now: number, width: number): string {
  return (
    `<style>.tx{font:500 11.5px ${FONT}}.nm{font:500 11.5px ${FONT}}.sm{font:400 11px ${FONT}}` +
    '.ink{fill:#E6EDF3}.dim{fill:#8B949E}.ico{stroke:#8B949E}' +
    '@media (prefers-color-scheme:light){.ink{fill:#1F2328}.dim{fill:#6E7781}.ico{stroke:#6E7781}}' +
    `.t0{animation:tw 2.2s ease-in-out infinite;animation-delay:${phase(now, 2.2)}}` +
    `.t1{animation:tw 2.8s ease-in-out infinite;animation-delay:${phase(now, 2.8, 0.7)}}` +
    `.t2{animation:tw 1.9s ease-in-out infinite;animation-delay:${phase(now, 1.9, 1.3)}}` +
    `.t3{animation:tw 3.3s ease-in-out infinite;animation-delay:${phase(now, 3.3, 0.4)}}` +
    '@keyframes tw{0%,100%{opacity:1}50%{opacity:.35}}' +
    `.pl{animation:pl 1.2s ease-in-out infinite;animation-delay:${phase(now, 1.2)}}@keyframes pl{50%{opacity:.3}}` +
    `.sh{animation:sh 2.8s linear infinite;animation-delay:${phase(now, 2.8)}}` +
    `@keyframes sh{from{transform:translateX(-140px)}to{transform:translateX(${width + 20}px)}}` +
    '@media (prefers-reduced-motion:reduce){.t0,.t1,.t2,.t3,.pl,.sh{animation:none}.sh{display:none}}</style>'
  )
}

// Dots in a band of the given box, a few twinkling at their own pace.
function dots(x0: number, x1: number, y: number, rows: number, color: string, opacity: number, seed: number): string {
  const byClass = new Map<string, string[]>()
  for (let col = 0; x0 + col * 3 + 2 < x1; col++) {
    for (let row = 0; row < rows; row++) {
      if (hash(col, row, seed) > 0.62) continue
      const cls = `t${Math.floor(hash(col, row, seed + 1) * 4)}`
      const d = `M${(x0 + col * 3).toFixed(1)} ${(y + row * 3.2).toFixed(1)}h1.7v1.7h-1.7z`
      byClass.set(cls, [...(byClass.get(cls) ?? []), d])
    }
  }

  return [...byClass]
    .map(([cls, parts]) => `<path class="${cls}" fill="${color}" fill-opacity="${opacity}" d="${parts.join('')}"/>`)
    .join('')
}

const agentsDone = (agents: readonly AgentRun[]) => agents.filter(a => a.state === 'done' || a.state === 'failed').length

// How far the bar is, 0 to 1: by its steps, or by its agents when it has no list.
export function barFraction(bar: Bar): number {
  if (bar.state === 'done') return 1
  if (bar.steps.length > 0) return fraction(bar.steps)
  if (bar.agents.length === 0) return 0

  return agentsDone(bar.agents) / bar.agents.length
}

// The words on the pill: the step at work, or how the bar stands.
export function pillLabel(bar: Bar, now: number): string {
  const step = bar.steps.find(one => one.status === 'active') ?? bar.steps.find(one => one.status === 'pending')
  const live = bar.agents.filter(a => a.state === 'running' || a.state === 'needs').length
  const doing = step?.title ?? (live > 0 ? `${live} agent${live === 1 ? '' : 's'} at work` : 'Working')
  if (bar.state === 'done') return `✓ ${since((bar.endedAt ?? now) - bar.startedAt)}`
  if (bar.state === 'needs') return `? ${bar.note || doing}`
  if (bar.state === 'error') return `✕ ${bar.note || doing}`

  return doing
}

// The desktop's track: a capsule, its done part a field of twinkling dots with a
// light sweeping over it, a pill at the leading edge naming the step at work,
// and a small mark for each step still ahead.
export function trackSvg(bar: Bar, width: number, now: number): string {
  const top = 3
  const tall = 16
  const color = PALETTE[bar.state]
  const label = fitText(pillLabel(bar, now), width * 0.55 - 22)
  const pillW = Math.min(width, textWidth(label) + 22)
  const head = barFraction(bar) * width
  const pillX = Math.max(0, Math.min(width - pillW, head - pillW / 2))
  const fillW = Math.max(head, pillX + pillW / 2)
  const id = `c${bar.id.replace(/[^a-z0-9]/gi, '')}`
  const marks = bar.steps
    .map((_, index) => ((index + 1) / bar.steps.length) * width)
    .slice(0, -1)
    .filter(x => x > pillX + pillW + 6)
    .map(x => `<circle cx="${x.toFixed(1)}" cy="${top + tall / 2}" r="1.8" class="dim" fill-opacity=".7"/>`)
    .join('')
  const sweep =
    bar.state === 'running'
      ? `<linearGradient id="${id}g"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".18"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>` +
        `<g clip-path="url(#${id}f)"><rect class="sh" x="0" y="${top}" width="120" height="${tall}" fill="url(#${id}g)"/></g>`
      : ''

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${TRACK_H}" viewBox="0 0 ${width} ${TRACK_H}">` +
    style(now, width) +
    `<clipPath id="${id}f"><rect x="0" y="${top}" width="${fillW.toFixed(1)}" height="${tall}" rx="${tall / 2}"/></clipPath>` +
    `<rect x="0" y="${top}" width="${width}" height="${tall}" rx="${tall / 2}" fill="#808080" fill-opacity=".16"/>` +
    `<rect x="0" y="${top}" width="${fillW.toFixed(1)}" height="${tall}" rx="${tall / 2}" fill="${color}" fill-opacity=".2"/>` +
    `<g clip-path="url(#${id}f)">${dots(4, fillW - 2, top + 2.6, 4, color, 0.75, 7)}</g>` +
    sweep +
    marks +
    `<rect x="${pillX.toFixed(1)}" y="1" width="${pillW.toFixed(1)}" height="20" rx="10" fill="${color}"/>` +
    `<text x="${(pillX + pillW / 2).toFixed(1)}" y="15" text-anchor="middle" class="tx" fill="${PILL_INK[bar.state]}">${esc(label)}</text>` +
    '</svg>'
  )
}

// A little robot, the agent's mark in the gutter.
const BOT =
  '<rect x="1.5" y="4.5" width="10" height="7.5" rx="2"/><path d="M6.5 4.5V2.2M4.5 8h.01M8.5 8h.01M0 8.2v1.6M13 8.2v1.6"/>'

export const GUTTER = 30

// One agent's row: its number, a tinted strip with a status dot, its name with
// the model and effort, the tool it is on, and its time.
export function agentSvg(agent: AgentRun, number: number, width: number, now: number, top = 0): string {
  const color = PALETTE[agent.state]
  const isLive = agent.state === 'running' || agent.state === 'needs'
  const time = since((agent.endedAt ?? now) - agent.startedAt)
  const word = agent.state === 'needs' ? 'Needs approval' : isLive ? toolWord(agent.tool) : agent.state === 'failed' ? agent.tool : ''
  const timeX = width - 9
  const toolEnd = timeX - textWidth(time) - 10
  const shownWord = word === '' ? '' : fitText(word, width * 0.25)
  const nameX = GUTTER + 19 + (agent.isNested ? 10 : 0)
  const room = toolEnd - (shownWord === '' ? 0 : textWidth(shownWord) + 12) - nameX
  const spec = [agent.model === '' ? '' : modelName(agent.model), agent.effort].filter(Boolean).join(' · ')
  const title = `${agent.isNested ? '↳ ' : ''}${agent.title}`
  const name = fitText(title, room)
  const specShown = name === title && spec !== '' ? fitText(` (${spec})`, room - textWidth(name)) : ''

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${STRIP_H + top}" viewBox="0 0 ${width} ${STRIP_H + top}">` +
    style(now, width) +
    `<g transform="translate(0 ${top})">` +
    `<g class="ico" fill="none" stroke-width="1.3" stroke-linecap="round" transform="translate(0 2.5)">${BOT}</g>` +
    `<text x="17" y="13" class="sm dim">${number}</text>` +
    `<rect x="${GUTTER}" y="0" width="${width - GUTTER}" height="${STRIP_H}" rx="${STRIP_H / 2}" fill="${color}" fill-opacity=".14"/>` +
    (agent.state === 'running' ? dots(GUTTER + 14, width - 10, 3.4, 4, color, 0.3, agent.title.length + number) : '') +
    `<circle cx="${GUTTER + 10 + (agent.isNested ? 10 : 0)}" cy="${STRIP_H / 2}" r="3" fill="${color}"${isLive ? ' class="pl"' : ''}/>` +
    `<text x="${nameX}" y="13" class="nm ink">${esc(name)}<tspan class="sm dim">${esc(specShown)}</tspan></text>` +
    (shownWord === '' ? '' : `<text x="${toolEnd.toFixed(1)}" y="13" text-anchor="end" class="sm" fill="${color}">${esc(shownWord)}</text>`) +
    `<text x="${timeX}" y="13" text-anchor="end" class="sm dim">${esc(time)}</text>` +
    '</g></svg>'
  )
}

// The agents past the rows shown, folded into one line.
export function moreSvg(hidden: readonly AgentRun[], width: number, top = 0): string {
  const done = agentsDone(hidden)
  const text = `${hidden.length} more agent${hidden.length === 1 ? '' : 's'} · ${done} done`

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${STRIP_H + top}" viewBox="0 0 ${width} ${STRIP_H + top}">` +
    style(0, width) +
    `<g transform="translate(0 ${top})">` +
    `<g class="ico" fill="none" stroke-width="1.3" stroke-linecap="round" transform="translate(0 2.5)">${BOT}</g>` +
    `<text x="17" y="13" class="sm dim">+${hidden.length}</text>` +
    `<rect x="${GUTTER}" y="0" width="${width - GUTTER}" height="${STRIP_H}" rx="${STRIP_H / 2}" fill="#808080" fill-opacity=".14"/>` +
    `<text x="${GUTTER + 10}" y="13" class="sm dim">${esc(text)}</text>` +
    '</g></svg>'
  )
}

// Which agents get a row: those at work first, then the latest finished; the
// rest are counted on one more line.
export function shownAgents(agents: readonly AgentRun[], budget: number): { shown: AgentRun[]; hidden: AgentRun[] } {
  if (agents.length <= budget) return { shown: [...agents], hidden: [] }
  const live = agents.filter(a => a.state === 'running' || a.state === 'needs')
  const ended = agents.filter(a => !live.includes(a)).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
  const room = Math.max(0, budget - 1)
  const picked = new Set([...live, ...ended].slice(0, room))

  return { shown: agents.filter(a => picked.has(a)), hidden: agents.filter(a => !picked.has(a)) }
}

// The terminal's track: one row of cells. The done part is braille dots in the
// bar's colour, a few brighter each second; the pill is the step's name on the
// colour; the rest is a dim rule with a mark at each step still ahead.
const BRAILLE = ['⣿', '⣷', '⣯', '⣟', '⡿', '⢿', '⣻', '⣽', '⣾', '⣶', '⣭']
const DIM_RULE = 0x3a3f47
const DIM_MARK = 0x6e7681
const DEFAULT = 0x01000000

const hex = (color: string) => Number.parseInt(color.slice(1), 16)
const shade = (color: number, k: number) =>
  (Math.round(((color >> 16) & 255) * k) << 16) | (Math.round(((color >> 8) & 255) * k) << 8) | Math.round((color & 255) * k)

export function trackCells(bar: Bar, columns: number, now: number): string {
  const color = hex(PALETTE[bar.state])
  const ink = hex(PILL_INK[bar.state])
  const raw = pillLabel(bar, now)
  const room = Math.max(4, Math.floor(columns * 0.55) - 2)
  const points = [...raw]
  const label = ` ${points.length > room ? `${points.slice(0, room - 1).join('')}…` : raw} `
  const pill = [...label]
  const head = Math.round(barFraction(bar) * columns)
  const pillAt = Math.max(0, Math.min(columns - pill.length, head - Math.floor(pill.length / 2)))
  const fillTo = Math.max(head, pillAt)
  const marks = new Set(bar.steps.slice(0, -1).map((_, index) => Math.round(((index + 1) / bar.steps.length) * columns)))
  const second = Math.floor(now / 1000)
  const words = new Uint32Array(columns * 3)
  for (let col = 0; col < columns; col++) {
    let char = '─'
    let fg = DIM_RULE
    let bg = DEFAULT
    if (col >= pillAt && col < pillAt + pill.length) {
      char = pill[col - pillAt] ?? ' '
      fg = ink
      bg = color
    } else if (col < fillTo) {
      char = BRAILLE[Math.floor(hash(col, 1, 3) * BRAILLE.length)] ?? '⣿'
      fg = shade(color, 0.55 + 0.45 * hash(col, second, 5))
    } else if (marks.has(col)) {
      char = '•'
      fg = DIM_MARK
    }
    words[col * 3] = char.codePointAt(0) ?? 32
    words[col * 3 + 1] = fg
    words[col * 3 + 2] = bg
  }

  return base64(new Uint8Array(words.buffer))
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function base64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1] ?? 0
    const c = bytes[i + 2] ?? 0
    const n = (a << 16) | (b << 8) | c
    out += ALPHABET[(n >> 18) & 63]
    out += ALPHABET[(n >> 12) & 63]
    out += i + 1 < bytes.length ? ALPHABET[(n >> 6) & 63] : '='
    out += i + 2 < bytes.length ? ALPHABET[n & 63] : '='
  }

  return out
}
