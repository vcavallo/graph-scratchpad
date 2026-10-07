// The app's own updates. The browser only looks for a new version when a page
// loads, and an installed app can stay open for days, so look again whenever
// it comes back to the front or back online (at most once a minute), every
// half hour while it's open, and when asked (Settings → About).

import type { Ref } from 'vue'

let reg: ServiceWorkerRegistration | undefined
let ready: Ref<boolean> | undefined
let last = 0

/** Once the service worker is registered (App.vue): needRefresh is the plugin's "a new version is waiting". */
export function trackUpdates(registration: ServiceWorkerRegistration, needRefresh: Ref<boolean>): void {
  reg = registration
  ready = needRefresh
  setInterval(() => void look(), 30 * 60 * 1000)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void look()
  })
  window.addEventListener('online', () => void look())
}

async function look(): Promise<void> {
  if (!reg || !navigator.onLine || Date.now() - last < 60_000) return
  last = Date.now()
  await reg.update().catch(() => {})
}

export type UpdateCheck = 'ready' | 'current' | 'offline' | 'unavailable'

/** Look now, and say what was found. */
export async function checkForUpdate(): Promise<UpdateCheck> {
  if (!reg || !ready) return 'unavailable'
  if (ready.value || reg.waiting) return 'ready'
  if (!navigator.onLine) return 'offline'
  last = Date.now()
  try {
    await reg.update()
  } catch {
    return navigator.onLine ? 'unavailable' : 'offline'
  }
  // Found one: wait for it to finish installing (the plugin then sets needRefresh).
  const sw = reg.installing
  if (sw) {
    await new Promise<void>((resolve) => {
      sw.addEventListener('statechange', () => sw.state !== 'installing' && resolve())
      setTimeout(resolve, 15_000)
    })
  }
  for (let i = 0; i < 20 && reg.waiting && !ready.value; i++) await new Promise((r) => setTimeout(r, 100))
  return ready.value || reg.waiting ? 'ready' : 'current'
}
