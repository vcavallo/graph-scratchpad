// Vim keys (a per-device preference): which mode the editor is in, shared by
// every line so moving between lines keeps it, plus the one register (yy, dd,
// p) and the one step of undo.
import { reactive } from 'vue'
import type { VimMode } from '@/lib/vim'
import { prefs } from './prefs'

/** A copied line, with what's inside it; ids are the original nodes'. */
export interface YankedLine {
  id: string
  text: string
  task: boolean
  done: boolean
  numbered: boolean
  children: YankedLine[]
}

/** What u undoes: the last change made with vim keys. u again redoes it, as in the original vi. */
export type VimUndo =
  /** Put a line's text back. */
  | { kind: 'text'; id: string; text: string }
  /** Bring back a deleted line (dd). */
  | { kind: 'restore'; id: string }
  /** Take away a line that was added (o, O, p). */
  | { kind: 'remove'; id: string }
  /** Put a line back where it was (>>, <<). */
  | { kind: 'place'; id: string; parent: string; after: string | null }

export const vim = reactive({
  enabled: prefs.vim,
  mode: 'normal' as VimMode,
  /** First key of a two-key command ("d" of "dd"). */
  pending: '',
  /** The column j/k keep to across short lines. */
  goal: null as number | null,
  /** yy and dd put the line here; p puts it back. `cut`: it came from dd, so p can move the line itself. */
  register: null as { line: YankedLine; cut: boolean } | null,
  undo: null as VimUndo | null,
})

export function setVimEnabled(on: boolean): void {
  prefs.vim = on
  vim.enabled = on
  vim.mode = 'normal'
  vim.pending = ''
  vim.goal = null
}

/** A new line to type into: start it in insert mode. */
export function vimInsert(): void {
  if (vim.enabled) vim.mode = 'insert'
}
