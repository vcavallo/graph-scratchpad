// "Send to…": put a line that's only a link to this item at the end of another
// list, so it shows up there (a to-do with its checkbox, done everywhere at
// once). The list sent to last is offered first.

import { api } from '@/db/api'
import { makeToken } from '@/lib/tokens'
import { prefs } from '@/state/prefs'
import { openPicker, reportError, toast, type SheetAction } from '@/state/ui'
import { ApiError } from '@/db/api'

async function send(item: { id: string; label: string }, to: { id: string; label: string }) {
  const id = crypto.randomUUID()
  try {
    await api.createChild(to.id, undefined, { text: makeToken(item.id), task: false, id })
    prefs.lastSendTo = to
    toast(`Sent to “${to.label}”`, {
      action: { label: 'Undo', run: () => void api.deleteSubtree(id).catch(reportError) },
    })
  } catch (e) {
    // The list was deleted since: stop offering it.
    if (e instanceof ApiError && (e.code === 'deleted' || e.code === 'not_found')) prefs.lastSendTo = null
    reportError(e)
  }
}

/** Sheet actions for an item: "Send to “Today”" (the last list) and "Send to…". */
export function sendActions(item: { id: string; label: string }, exclude: string[]): SheetAction[] {
  const actions: SheetAction[] = []
  const last = prefs.lastSendTo
  if (last && !exclude.includes(last.id)) {
    actions.push({ label: `Send to “${last.label || 'Untitled'}”`, icon: 'share', run: () => void send(item, last) })
  }
  actions.push({
    label: 'Send to…',
    icon: 'share',
    run: () =>
      openPicker({
        mode: 'send',
        title: `Send “${item.label}” to`,
        placeholder: 'Search, or browse below',
        excludeIds: exclude,
        onPick: (r) => void send(item, { id: r.id, label: r.label }),
      }),
  })
  return actions
}
