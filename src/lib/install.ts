// Is the app running in its own window (installed) or in a browser tab, and
// can we offer the browser's install prompt? Browsers without WebAPKs
// (Vanadium, for one) still install a PWA as a home-screen app that opens
// without the address bar; a plain bookmark shortcut opens a normal tab.

import { reactive } from 'vue'

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export const installState = reactive({
  /** Opened as an installed app (no browser UI). */
  standalone: false,
  /** The browser has offered to install it (beforeinstallprompt). */
  canInstall: false,
  installed: false,
})

let deferred: BeforeInstallPromptEvent | null = null

export function trackInstall(): void {
  const mq = matchMedia('(display-mode: standalone), (display-mode: fullscreen), (display-mode: minimal-ui)')
  installState.standalone = mq.matches
  mq.addEventListener('change', (e) => (installState.standalone = e.matches))
  // Keep the event (without suppressing the browser's own banner) so Settings can offer it too.
  window.addEventListener('beforeinstallprompt', (e) => {
    deferred = e as BeforeInstallPromptEvent
    installState.canInstall = true
  })
  window.addEventListener('appinstalled', () => {
    installState.installed = true
    installState.canInstall = false
    deferred = null
  })
}

/** Show the browser's install dialog. Resolves true if the user accepted. */
export async function promptInstall(): Promise<boolean> {
  const e = deferred
  if (!e) return false
  deferred = null
  installState.canInstall = false
  await e.prompt()
  return (await e.userChoice).outcome === 'accepted'
}
