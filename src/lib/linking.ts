// The @-link flow shared by outline rows and titles: open the picker, then
// put a [[uuid]] token where the caret was (replacing the typed "@").

import { makeToken } from './tokens'
import { getEditor } from '@/state/focus'
import { mergeRefs } from '@/state/refs'
import { openPicker } from '@/state/ui'
import { api } from '@/db/api'
import { categories, pinnedCategories } from '@/state/categories'

/** "New in Places: “Ace Hardware”", for your pinned kinds first, then the rest; then an item in the Inbox. */
function createOptions() {
  const kinds = [...pinnedCategories.value, ...categories.value.filter((c) => !c.pinned)].slice(0, 4)
  return [
    ...kinds.map((c) => ({
      key: c.id,
      kind: 'item' as const,
      label: (t: string) => `New in ${c.name}: “${t}”`,
      create: (text: string, id: string) => api.createContext(text, c.id, id),
    })),
    {
      key: 'inbox',
      kind: 'item' as const,
      label: (t: string) => `New item “${t}” in Inbox`,
      create: (text: string, id: string) => api.createInInbox({ text, id }),
    },
  ]
}

export function openLinkPicker(editorKey: string, offset: number, typedAt: boolean, selfId?: string): void {
  openPicker({
    mode: 'link',
    title: 'Link to',
    placeholder: 'Search items, places, people',
    excludeIds: selfId ? [selfId] : [],
    allowCreate: true,
    createOptions: createOptions(),
    onPick: (r) => {
      const ed = getEditor(editorKey)
      if (!ed) return
      mergeRefs({ [r.id]: { id: r.id, kind: r.kind, label: r.label, done: false, task: false, deleted: false, tone: null, exists: true } })
      const t = ed.text()
      const start = typedAt && t[offset - 1] === '@' ? offset - 1 : Math.min(offset, t.length)
      const end = typedAt && t[offset - 1] === '@' ? offset : start
      let before = t.slice(0, start)
      const after = t.slice(end)
      if (before && !/\s$/.test(before)) before += ' '
      const token = makeToken(r.id)
      const sep = after.startsWith(' ') ? '' : ' '
      const next = before + token + sep + after
      const caret = before.length + token.length + sep.length
      ed.focus(Math.min(start, next.length))
      ed.replace(next, { caret })
      void ed.flush()
    },
    onCancel: () => getEditor(editorKey)?.focus(offset),
  })
}
