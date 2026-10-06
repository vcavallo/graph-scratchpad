// Page-side sync triggers. The worker does the syncing; this nudges it when
// it's likely to matter: the app comes back to the foreground, the network
// returns, another device changed something (server-sent events), and every
// few minutes while the app is open.

import { watch } from 'vue'
import { api, syncState } from '@/db/api'

const PERIODIC = 5 * 60_000

let events: EventSource | null = null
let eventsUrl = ''

function nudge() {
  if (syncState.enabled) void api.syncNow().catch(() => {})
}

/** Listen to the server's change announcements at `url` ('' to stop). */
function listen(url: string) {
  if (events && url === eventsUrl) return
  events?.close()
  events = null
  eventsUrl = url
  if (url && typeof EventSource !== 'undefined') {
    events = new EventSource(url)
    events.addEventListener('seq', (e) => {
      // Our own pushes come back as events too; only pull when there's something past our cursor.
      if (Number((e as MessageEvent).data) > syncState.cursor) nudge()
    })
  }
}

export function startSyncTriggers(): void {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') nudge()
  })
  window.addEventListener('online', nudge)
  setInterval(() => {
    if (document.visibilityState === 'visible') nudge()
  }, PERIODIC)
  watch(() => (syncState.enabled && syncState.available ? syncState.events : ''), listen, { immediate: true })
}
