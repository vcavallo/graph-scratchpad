// DOM helpers for the contenteditable line editor. Text is stored with
// [[uuid]] tokens; in the DOM each token is a non-editable chip span.
// Caret offsets are measured in serialized-text units (a chip counts as the
// length of its token), so they survive re-rendering.

import type { RefInfo } from '@/db/types'
import { makeToken, splitTokens } from './tokens'

export const ZWSP = '​'
const TOKEN_LEN = makeToken('00000000-0000-0000-0000-000000000000').length

export function chipLabel(ref: RefInfo | undefined): string {
  if (!ref) return '…'
  if (!ref.exists) return 'missing link'
  const l = ref.label || 'Untitled'
  return l.length > 48 ? l.slice(0, 47) + '…' : l
}

export function chipClass(ref: RefInfo | undefined): string {
  // Contexts take their kind’s colour; everything else is coloured by node kind.
  const c = ['chip', ref?.tone != null ? `chip-tone-${ref.tone}` : `chip-${ref?.kind ?? 'item'}`]
  if (ref?.deleted) c.push('chip-deleted')
  if (ref?.done) c.push('chip-done')
  return c.join(' ')
}

function makeChip(id: string, ref: RefInfo | undefined): HTMLElement {
  const s = document.createElement('span')
  s.className = chipClass(ref)
  s.contentEditable = 'false'
  s.dataset.id = id
  s.textContent = chipLabel(ref)
  return s
}

const isChip = (n: Node): n is HTMLElement =>
  n.nodeType === Node.ELEMENT_NODE && (n as HTMLElement).classList.contains('chip') && !!(n as HTMLElement).dataset.id

/**
 * Fill the editor from stored text. Empty editors and chips at either end get
 * a zero-width space so Android keyboards always have a caret position (and
 * something to backspace over).
 */
export function renderEditor(el: HTMLElement, text: string, refs: Record<string, RefInfo>): void {
  const nodes: Node[] = []
  const segs = splitTokens(text)
  if (segs.length === 0 || segs[0].type === 'link') nodes.push(document.createTextNode(ZWSP))
  for (const seg of segs) {
    nodes.push(seg.type === 'text' ? document.createTextNode(seg.value) : makeChip(seg.id, refs[seg.id]))
  }
  if (segs.length && segs[segs.length - 1].type === 'link') nodes.push(document.createTextNode(ZWSP))
  el.replaceChildren(...nodes)
}

/** Update chip labels/state in place (safe while the user is typing). */
export function updateChips(el: HTMLElement, refs: Record<string, RefInfo>): void {
  el.querySelectorAll<HTMLElement>('.chip[data-id]').forEach((chip) => {
    const ref = refs[chip.dataset.id!]
    if (!ref) return
    const cls = chipClass(ref)
    if (chip.className !== cls) chip.className = cls
    const label = chipLabel(ref)
    if (chip.textContent !== label) chip.textContent = label
  })
}

export function serialize(root: Node): string {
  let out = ''
  const walk = (n: Node) => {
    n.childNodes.forEach((c) => {
      if (c.nodeType === Node.TEXT_NODE) out += (c as Text).data
      else if (isChip(c)) out += makeToken(c.dataset.id!)
      else if (c.nodeType === Node.ELEMENT_NODE && (c as HTMLElement).tagName !== 'BR') walk(c)
    })
  }
  walk(root)
  return out.replace(/​/g, '').replace(/[\r\n]+/g, ' ').replace(/ /g, ' ')
}

function chipAncestor(el: HTMLElement, node: Node): HTMLElement | null {
  for (let n: Node | null = node; n && n !== el; n = n.parentNode) if (isChip(n)) return n
  return null
}

function offsetOf(el: HTMLElement, node: Node, offset: number): number {
  const chip = chipAncestor(el, node)
  const r = document.createRange()
  r.selectNodeContents(el)
  if (chip) r.setEndAfter(chip)
  else r.setEnd(node, offset)
  return serialize(r.cloneContents()).length
}

export function getCaret(el: HTMLElement): { start: number; end: number } | null {
  const sel = document.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  const r = sel.getRangeAt(0)
  if (!el.contains(r.startContainer) || !el.contains(r.endContainer)) return null
  return { start: offsetOf(el, r.startContainer, r.startOffset), end: offsetOf(el, r.endContainer, r.endOffset) }
}

export type CaretTarget = number | 'start' | 'end'

export type Shortcut = 'toggle-done' | 'toggle-task' | 'move-up' | 'move-down' | 'collapse' | 'expand'

/**
 * A line's kind, as written in Markdown: "[ ] …" / "[x] …" is a to-do, "- …" a
 * plain bullet, "1. …" (or "1) …") a numbered list.
 */
export interface LineMarker {
  /** To-do (true) or plain bullet (false); undefined leaves it as it is. */
  task?: boolean
  done: boolean
  /** Number the list the line is in. */
  numbered?: boolean
}

const TYPED_MARKER = /^(?:\[([ xX]?)\]|[-*]|(\d{1,3})[.)]) /

/**
 * A marker typed at the very start of a line ("[] ", "[x] ", "- ", and with
 * `numbers`, "1. " or "1) "): its length and meaning.
 */
export function typedMarker(text: string, opts: { numbers?: boolean } = {}): (LineMarker & { length: number }) | null {
  const m = TYPED_MARKER.exec(text)
  if (!m) return null
  if (m[2] !== undefined) return opts.numbers ? { length: m[0].length, done: false, numbered: true } : null
  const box = m[1]
  return { length: m[0].length, task: box !== undefined, done: !!box && box.toLowerCase() === 'x' }
}

export function setCaret(el: HTMLElement, target: CaretTarget): void {
  const sel = document.getSelection()
  if (!sel) return
  const range = document.createRange()
  let placed = false
  if (target !== 'end') {
    let remaining = target === 'start' ? 0 : target
    for (const c of Array.from(el.childNodes)) {
      if (c.nodeType === Node.TEXT_NODE) {
        const data = (c as Text).data
        let i = 0
        let count = 0
        while (i < data.length && count < remaining) {
          if (data[i] !== ZWSP) count++
          i++
        }
        if (count === remaining) {
          while (i < data.length && data[i] === ZWSP) i++
          range.setStart(c, i)
          placed = true
          break
        }
        remaining -= count
      } else if (isChip(c)) {
        if (remaining === 0) {
          range.setStartBefore(c)
          placed = true
          break
        }
        remaining = Math.max(0, remaining - TOKEN_LEN)
        if (remaining === 0 && !c.nextSibling) {
          range.setStartAfter(c)
          placed = true
          break
        }
      } else {
        const len = serialize(c).length
        if (remaining <= len) {
          range.setStartAfter(c)
          placed = true
          break
        }
        remaining -= len
      }
    }
  }
  if (!placed) {
    range.selectNodeContents(el)
    range.collapse(false)
  } else {
    range.collapse(true)
  }
  sel.removeAllRanges()
  sel.addRange(range)
}

/** True when the caret sits on the first (or last) visual line of the element. */
export function caretOnEdgeLine(el: HTMLElement, edge: 'first' | 'last'): boolean {
  const sel = document.getSelection()
  if (!sel || sel.rangeCount === 0) return true
  const r = sel.getRangeAt(0).cloneRange()
  r.collapse(true)
  let rect = r.getClientRects()[0]
  if (!rect) {
    // Collapsed ranges at a node boundary can have no rects; measure a char.
    const probe = document.createRange()
    probe.selectNodeContents(el)
    rect = probe.getClientRects()[0]
    if (!rect) return true
  }
  const box = el.getBoundingClientRect()
  const line = parseFloat(getComputedStyle(el).lineHeight) || 24
  return edge === 'first' ? rect.top - box.top < line * 0.75 : box.bottom - rect.bottom < line * 0.75
}

export interface PastedLine {
  text: string
  /** Set when the line had a checkbox ("[ ]" or "[x]"); otherwise it follows the line it's pasted after. */
  task?: boolean
  done?: boolean
  /** It was numbered ("1. …"): the list it lands in becomes a numbered list. */
  numbered?: boolean
}

/** Clean up pasted text into lines, dropping list markers like "- ", "* ", "1. ", "[ ] " (but keeping checkboxes and numbering). */
export function pasteLines(text: string): PastedLine[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => {
      const m = /^\s*(?:[-*•+]\s+|(\d{1,3})[.)]\s+)?(?:\[([ xX]?)\]\s+)?/.exec(l)!
      const line: PastedLine = { text: l.slice(m[0].length).trimEnd() }
      if (m[1] !== undefined) line.numbered = true
      if (m[2] !== undefined) {
        line.task = true
        line.done = m[2].toLowerCase() === 'x'
      }
      return line
    })
    .filter((l) => l.text.length > 0)
}
