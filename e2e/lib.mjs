// Shared helpers for the browser checks: launch system Chromium with phone
// emulation (touch, Pixel-ish viewport) against a running preview server.

import { chromium, devices } from 'playwright-core'
import { existsSync, mkdirSync } from 'node:fs'

export const BASE = process.env.BASE_URL ?? 'http://localhost:4173'
export const SHOTS = new URL('./shots/', import.meta.url).pathname
mkdirSync(SHOTS, { recursive: true })

function chromiumPath() {
  for (const p of [
    process.env.CHROMIUM,
    '/run/current-system/sw/bin/chromium',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ]) {
    if (p && existsSync(p)) return p
  }
  throw new Error('No Chromium found; set CHROMIUM=/path/to/chromium')
}

export async function launch({ userDataDir, colorScheme = 'light' } = {}) {
  const opts = {
    executablePath: chromiumPath(),
    headless: true,
    ...devices['Pixel 7'],
    colorScheme,
    args: ['--no-sandbox'],
  }
  if (userDataDir) {
    const ctx = await chromium.launchPersistentContext(userDataDir, opts)
    return { ctx, close: () => ctx.close() }
  }
  const browser = await chromium.launch({ executablePath: opts.executablePath, headless: true, args: opts.args })
  const ctx = await browser.newContext({ ...devices['Pixel 7'], colorScheme })
  return { ctx, close: () => browser.close() }
}

export function watchConsole(page, label = '') {
  const errors = []
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(`${label}[${m.type()}] ${m.text()}`)
  })
  page.on('pageerror', (e) => errors.push(`${label}[pageerror] ${e.message}`))
  return errors
}

export async function shot(page, name) {
  await page.screenshot({ path: `${SHOTS}${name}.png` })
}

/** Text of each outline row, with depth, as "  child" style lines. */
export async function outline(page) {
  return page.$$eval('.outline .row', (rows) =>
    rows.map((r) => {
      const depth = Number(getComputedStyle(r).getPropertyValue('--depth') || 0)
      const t = r.querySelector('.row-text')
      const text = Array.from(t.childNodes)
        .map((n) => (n.nodeType === 3 ? n.data : n.classList?.contains('chip') ? `[${n.textContent}]` : n.textContent))
        .join('')
        .replace(/​/g, '')
      const done = r.classList.contains('done') ? ' ✓' : ''
      return '  '.repeat(depth) + text + done
    }),
  )
}

export async function activeRowText(page) {
  return page.evaluate(() => {
    const a = document.activeElement
    return a?.classList.contains('editable') ? a.textContent.replace(/​/g, '') : null
  })
}

export function assert(cond, msg) {
  if (!cond) throw new Error('Assertion failed: ' + msg)
  console.log('  ok -', msg)
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
