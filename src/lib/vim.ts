// Vim keys for the line editor: a small modal subset (normal and insert),
// for desktop keyboards. Pure: it reads a line's text (with [[uuid]] tokens,
// each one cell) and caret offset, and says what to do; the editor applies it.

import { tokenRe } from './tokens'

export type VimMode = 'normal' | 'insert'

/** Where the caret goes on another line. */
export type VimPlace = { column: number } | 'start' | 'end'

export type VimRowAction =
  | { action: 'down' | 'up'; place: VimPlace }
  | { action: 'first' | 'last' }
  | { action: 'open-below' | 'open-above' | 'delete' | 'indent' | 'outdent' | 'fold' | 'unfold' | 'fold-toggle' }

export interface VimResult {
  /** Keys typed so far of a two-key command ("d" of "dd"). */
  pending: string
  /** The line's new text, when it changed. */
  text?: string
  /** The caret offset (in the new text). */
  caret?: number
  mode?: VimMode
  /** Something for the outline to do: go to another line, open one, delete this one… */
  row?: VimRowAction
}

/** Offsets where each cell starts: a character (a whole emoji), or a whole link token. */
export function cells(text: string): number[] {
  const out: number[] = []
  const push = (from: number, to: number) => {
    for (let i = from; i < to; ) {
      out.push(i)
      const c = text.charCodeAt(i)
      i += c >= 0xd800 && c <= 0xdbff && i + 1 < to ? 2 : 1
    }
  }
  let i = 0
  for (const m of text.matchAll(tokenRe())) {
    push(i, m.index!)
    out.push(m.index!)
    i = m.index! + m[0].length
  }
  push(i, text.length)
  return out
}

/** The index of the cell the offset is in (or the last cell, past the end). */
function cellAt(cs: number[], offset: number): number {
  let lo = 0
  for (let i = 0; i < cs.length && cs[i] <= offset; i++) lo = i
  return lo
}

type Kind = 'blank' | 'word' | 'link' | 'punct'

function kindOf(text: string, cs: number[], i: number): Kind {
  const ch = text.slice(cs[i], cs[i + 1] ?? text.length)
  if (ch.startsWith('[[') && ch.length > 2) return 'link'
  if (/^\s$/.test(ch)) return 'blank'
  return /^[\p{L}\p{N}_]/u.test(ch) ? 'word' : 'punct'
}

/** Start of the next word after cell i, or null at the end of the line. */
function nextWord(text: string, cs: number[], i: number): number | null {
  const k = kindOf(text, cs, i)
  let j = i + 1
  if (k === 'word' || k === 'punct') while (j < cs.length && kindOf(text, cs, j) === k) j++
  while (j < cs.length && kindOf(text, cs, j) === 'blank') j++
  return j < cs.length ? j : null
}

/** Start of the word before cell i (or the one it's in), or null at the start. */
function prevWord(text: string, cs: number[], i: number): number | null {
  let j = i - 1
  while (j >= 0 && kindOf(text, cs, j) === 'blank') j--
  if (j < 0) return null
  const k = kindOf(text, cs, j)
  if (k !== 'link') while (j > 0 && kindOf(text, cs, j - 1) === k) j--
  return j
}

/** End of the word after cell i (or the one it's in). */
function wordEnd(text: string, cs: number[], i: number): number {
  let j = i + 1
  while (j < cs.length && kindOf(text, cs, j) === 'blank') j++
  if (j >= cs.length) return cs.length - 1
  const k = kindOf(text, cs, j)
  if (k !== 'link') while (j + 1 < cs.length && kindOf(text, cs, j + 1) === k) j++
  return j
}

function firstNonBlank(text: string, cs: number[]): number {
  let j = 0
  while (j < cs.length - 1 && kindOf(text, cs, j) === 'blank') j++
  return j
}

/** In normal mode the caret sits on a cell: never past the last one. */
export function normalCaret(text: string, offset: number): number {
  const cs = cells(text)
  return cs.length ? cs[cellAt(cs, offset)] : 0
}

/** The cell the caret is on, as an offset range (null on an empty line). */
export function cellRange(text: string, offset: number): { start: number; end: number } | null {
  const cs = cells(text)
  if (!cs.length) return null
  const i = cellAt(cs, offset)
  return { start: cs[i], end: cs[i + 1] ?? text.length }
}

/** The column (cell index) of an offset, for moving to the line above or below. */
export function columnOf(text: string, offset: number): number {
  const cs = cells(text)
  return cs.length ? cellAt(cs, offset) : 0
}

/** Where a VimPlace lands on a line of text, as a caret offset. */
export function placeOn(text: string, place: VimPlace): number {
  const cs = cells(text)
  if (!cs.length) return 0
  if (place === 'start') return cs[firstNonBlank(text, cs)]
  if (place === 'end') return cs[prevWord(text, cs, cs.length) ?? 0]
  return cs[Math.min(place.column, cs.length - 1)]
}

/** Leaving insert mode: the caret steps back onto the character before it, like vim. */
export function escapeCaret(text: string, offset: number): number {
  const cs = cells(text)
  if (!cs.length || offset === 0) return 0
  return cs[cellAt(cs, offset - 1)]
}

const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph'])

/** A key pressed in normal mode (no Ctrl, Alt or Cmd). null: not a vim key, let the editor have it. */
export function vimKey(pending: string, key: string, text: string, caret: number): VimResult | null {
  // Shift on its way to "$" or "G" mustn't cancel a "d" waiting for it.
  if (MODIFIERS.has(key)) return null
  const cs = cells(text)
  const n = cs.length
  const i = n ? cellAt(cs, caret) : 0
  const off = (k: number) => (k >= n ? text.length : cs[Math.max(0, k)])
  const on = (k: number) => (n ? cs[Math.max(0, Math.min(k, n - 1))] : 0)
  const edit = (from: number, to: number, after: Omit<VimResult, 'pending'> = {}): VimResult => {
    const t = text.slice(0, from) + text.slice(to)
    return { pending: '', text: t, caret: after.mode === 'insert' ? from : normalCaret(t, from), ...after }
  }
  const printable = key.length === 1 || [...key].length === 1

  if (pending === 'r') {
    if (!printable || !n) return { pending: '' }
    return { pending: '', text: text.slice(0, cs[i]) + key + text.slice(off(i + 1)), caret: cs[i] }
  }
  if (pending === 'g') return key === 'g' ? { pending: '', row: { action: 'first' } } : { pending: '' }
  if (pending === 'z') {
    const action = ({ a: 'fold-toggle', c: 'fold', o: 'unfold' } as const)[key as 'a' | 'c' | 'o']
    return action ? { pending: '', row: { action } } : { pending: '' }
  }
  if (pending === '>' || pending === '<') {
    return key === pending ? { pending: '', row: { action: key === '>' ? 'indent' : 'outdent' } } : { pending: '' }
  }
  if (pending === 'd' || pending === 'c') {
    const change = pending === 'c'
    const after = change ? ({ mode: 'insert' } as const) : {}
    if (key === pending) return change ? { pending: '', text: '', caret: 0, mode: 'insert' } : { pending: '', row: { action: 'delete' } }
    if (!n) return change && key !== 'Escape' ? { pending: '', mode: 'insert', caret: 0 } : { pending: '' }
    switch (key) {
      case 'w':
        // "cw" changes to the end of the word, like vim; "dw" takes the space after it too.
        if (change && kindOf(text, cs, i) !== 'blank') return edit(cs[i], off(wordEnd(text, cs, i - 1) + 1), after)
        return edit(cs[i], off(nextWord(text, cs, i) ?? n), after)
      case 'e':
        return edit(cs[i], off(wordEnd(text, cs, i) + 1), after)
      case 'b':
        return edit(cs[prevWord(text, cs, i) ?? 0], cs[i], after)
      case '$':
        return edit(cs[i], text.length, after)
      case '0':
        return edit(0, cs[i], after)
      case 'h':
        return i > 0 ? edit(cs[i - 1], cs[i], after) : { pending: '' }
      case 'l':
        return edit(cs[i], off(i + 1), after)
    }
    return { pending: '' }
  }

  switch (key) {
    case 'h':
    case 'ArrowLeft':
    case 'Backspace':
      return { pending: '', caret: on(i - 1) }
    case 'l':
    case 'ArrowRight':
    case ' ':
      return { pending: '', caret: on(i + 1) }
    case '0':
    case 'Home':
      return { pending: '', caret: 0 }
    case '^':
      return { pending: '', caret: n ? cs[firstNonBlank(text, cs)] : 0 }
    case '$':
    case 'End':
      return { pending: '', caret: on(n - 1) }
    case 'w': {
      const j = n ? nextWord(text, cs, i) : null
      return j === null ? { pending: '', row: { action: 'down', place: 'start' } } : { pending: '', caret: cs[j] }
    }
    case 'b': {
      const j = n ? prevWord(text, cs, i) : null
      return j === null ? { pending: '', row: { action: 'up', place: 'end' } } : { pending: '', caret: cs[j] }
    }
    case 'e':
      return { pending: '', caret: n ? cs[wordEnd(text, cs, i)] : 0 }
    case 'j':
    case 'ArrowDown':
      return { pending: '', row: { action: 'down', place: { column: i } } }
    case 'k':
    case 'ArrowUp':
      return { pending: '', row: { action: 'up', place: { column: i } } }
    case 'Enter':
      return { pending: '', row: { action: 'down', place: 'start' } }
    case 'G':
      return { pending: '', row: { action: 'last' } }
    case 'g':
    case 'd':
    case 'c':
    case 'z':
    case '>':
    case '<':
    case 'r':
      return { pending: key }
    case 'i':
      return { pending: '', mode: 'insert', caret: off(i) }
    case 'a':
      return { pending: '', mode: 'insert', caret: off(i + 1) }
    case 'I':
      return { pending: '', mode: 'insert', caret: n ? cs[firstNonBlank(text, cs)] : 0 }
    case 'A':
      return { pending: '', mode: 'insert', caret: text.length }
    case 'o':
      return { pending: '', mode: 'insert', row: { action: 'open-below' } }
    case 'O':
      return { pending: '', mode: 'insert', row: { action: 'open-above' } }
    case 'x':
    case 'Delete':
      return n ? edit(cs[i], off(i + 1)) : { pending: '' }
    case 'X':
      return i > 0 ? edit(cs[i - 1], cs[i]) : { pending: '' }
    case 'D':
      return n ? edit(cs[i], text.length) : { pending: '' }
    case 'C':
      return n ? edit(cs[i], text.length, { mode: 'insert' }) : { pending: '', mode: 'insert', caret: 0 }
    case 's':
      return n ? edit(cs[i], off(i + 1), { mode: 'insert' }) : { pending: '', mode: 'insert', caret: 0 }
    case 'S':
      return { pending: '', text: '', caret: 0, mode: 'insert' }
    case 'Escape':
      return { pending: '' }
  }
  // Any other character does nothing in normal mode; other keys (Tab…) go to the editor.
  return printable ? { pending: '' } : null
}
