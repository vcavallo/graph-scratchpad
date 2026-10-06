// Light or dark: the system's choice unless this device picked one in Settings
// → Appearance. index.html sets it before the first paint; this keeps it in
// step afterwards (a change in Settings, or the system switching at sunset).

import { reactive } from 'vue'
import { prefs } from '@/state/prefs'

export type ThemeChoice = 'system' | 'light' | 'dark'

const PAPER = { light: '#f4f7f8', dark: '#0f2b47' }
const systemDark = () => matchMedia('(prefers-color-scheme: dark)').matches

export const theme = reactive({ choice: (prefs.theme ?? 'system') as ThemeChoice })

function apply(): void {
  const dark = theme.choice === 'dark' || (theme.choice === 'system' && systemDark())
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content', dark ? PAPER.dark : PAPER.light)
}

export function setTheme(choice: ThemeChoice): void {
  theme.choice = choice
  prefs.theme = choice === 'system' ? null : choice
  apply()
}

export function trackTheme(): void {
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', apply)
  apply()
}
