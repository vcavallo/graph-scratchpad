// Vim keys (a per-device preference): which mode the editor is in, shared by
// every line so moving between lines keeps it.
import { reactive } from 'vue'
import type { VimMode } from '@/lib/vim'
import { prefs } from './prefs'

export const vim = reactive({
  enabled: prefs.vim,
  mode: 'normal' as VimMode,
  /** First key of a two-key command ("d" of "dd"). */
  pending: '',
  /** The column j/k keep to across short lines. */
  goal: null as number | null,
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
