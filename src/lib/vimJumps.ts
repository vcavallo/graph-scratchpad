// With Vim keys on, Ctrl-O and Ctrl-I go back and forward through pages,
// like vim's jump list, and land on the line you were on (in normal mode).
// gx goes through here too, so the page it opens starts on its title.

import type { CaretTarget } from './editorDom'
import { router } from '@/router'
import { editing, getEditor } from '@/state/focus'
import { vim } from '@/state/vim'
import { toast } from '@/state/ui'

/** The line you were on, per page. */
const spots = new Map<string, { key: string; at: CaretTarget }>()
const MAX_SPOTS = 50
let jumping = false

/** Focus an editor once its page has loaded and it has mounted (or give up). */
function focusWhenReady(key: string, at: CaretTarget, ms = 2000) {
  const until = Date.now() + ms
  const tick = () => {
    const ed = getEditor(key)
    if (ed) return ed.focus(at)
    if (Date.now() < until) setTimeout(tick, 50)
  }
  tick()
}

/** gx: open a page, starting on its title in normal mode. */
export function vimOpen(path: string): void {
  jumping = true
  vim.mode = 'normal'
  void router.push(path)
}

function jump(dir: 'back' | 'forward') {
  const state = window.history.state as { back?: string | null; forward?: string | null } | null
  if (!(dir === 'back' ? state?.back : state?.forward)) return toast(dir === 'back' ? 'Nothing to go back to' : 'Nothing to go forward to')
  jumping = true
  vim.mode = 'normal'
  if (dir === 'back') router.back()
  else router.forward()
}

export function startVimJumps(): void {
  router.beforeEach((_to, from) => {
    const key = editing.key
    if (!key) return
    spots.delete(from.fullPath)
    spots.set(from.fullPath, { key, at: getEditor(key)?.caret() ?? 'start' })
    if (spots.size > MAX_SPOTS) spots.delete(spots.keys().next().value!)
  })
  router.afterEach((to) => {
    if (!jumping) return
    jumping = false
    const spot = spots.get(to.fullPath)
    if (spot) focusWhenReady(spot.key, spot.at)
    else if (typeof to.params.id === 'string') focusWhenReady(`title:${to.params.id}`, 'start')
  })
  window.addEventListener('keydown', (e) => {
    if (!vim.enabled || !e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
    const k = e.key.toLowerCase()
    if (k !== 'o' && k !== 'i') return
    // Search boxes and dialogs keep their keys.
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return
    e.preventDefault()
    jump(k === 'o' ? 'back' : 'forward')
  })
}
