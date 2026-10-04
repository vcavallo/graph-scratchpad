// navigator.storage persistence, plus a note of when the last backup was taken.

import { reactive } from 'vue'
import { prefs } from '@/state/prefs'

export const storageStatus = reactive({
  persisted: null as boolean | null,
  usage: undefined as number | undefined,
  quota: undefined as number | undefined,
  async refresh() {
    try {
      storageStatus.persisted = (await navigator.storage?.persisted?.()) ?? false
      const est = await navigator.storage?.estimate?.()
      storageStatus.usage = est?.usage
      storageStatus.quota = est?.quota
    } catch {
      storageStatus.persisted = false
    }
  },
})

export async function requestPersistence(): Promise<boolean> {
  try {
    const granted = (await navigator.storage?.persist?.()) ?? false
    storageStatus.persisted = granted
    return granted
  } catch {
    return false
  }
}

/** On first run, ask the browser not to evict our data. */
export async function persistOnFirstRun(): Promise<void> {
  if (prefs.persistAsked) return
  prefs.persistAsked = true
  await requestPersistence()
}

function readBackup(): number | null {
  try {
    const v = localStorage.getItem('gs.lastBackup')
    return v ? Number(v) : null
  } catch {
    return null
  }
}

export const lastBackup = reactive({ at: readBackup() })

export function recordBackup(): void {
  lastBackup.at = Date.now()
  try {
    localStorage.setItem('gs.lastBackup', String(lastBackup.at))
  } catch {
    // Not critical.
  }
}
