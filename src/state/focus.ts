// Registry of mounted line editors, so the outline can move focus (and the
// caret) to a row by node id, even one that hasn't rendered yet.

import { reactive } from 'vue'
import type { CaretTarget } from '@/lib/editorDom'

export interface EditorHandle {
  focus(at?: CaretTarget): void
  caret(): number | null
  text(): string
  /** Replace the content. `saved: true` means the database already has it. */
  replace(text: string, opts?: { saved?: boolean; caret?: CaretTarget }): void
  flush(): Promise<void>
  isFocused(): boolean
  insertText(s: string): void
}

const editors = new Map<string, EditorHandle>()
let pending: { key: string; at?: CaretTarget } | null = null

/** The key of the editor that has focus, or null. Drives the keyboard toolbar. */
export const editing = reactive({ key: null as string | null })
let blurTimer: ReturnType<typeof setTimeout> | undefined

export function registerEditor(key: string, h: EditorHandle): void {
  editors.set(key, h)
  if (pending?.key === key) {
    const p = pending
    pending = null
    h.focus(p.at)
  }
}

export function unregisterEditor(key: string, h: EditorHandle): void {
  if (editors.get(key) === h) editors.delete(key)
}

export function getEditor(key: string): EditorHandle | undefined {
  return editors.get(key)
}

/** Focus an editor now, or as soon as it mounts. */
export function focusEditor(key: string, at?: CaretTarget): void {
  const h = editors.get(key)
  if (h) {
    pending = null
    h.focus(at)
  } else {
    pending = { key, at }
  }
}

export function noteFocus(key: string): void {
  clearTimeout(blurTimer)
  editing.key = key
}

export function noteBlur(key: string): void {
  clearTimeout(blurTimer)
  // Focus often hops between editors; don't flash the toolbar off and on.
  blurTimer = setTimeout(() => {
    if (editing.key === key) editing.key = null
  }, 120)
}

export function activeEditor(): EditorHandle | undefined {
  return editing.key ? editors.get(editing.key) : undefined
}
