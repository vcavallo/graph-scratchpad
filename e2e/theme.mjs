// Light, dark, or the system's: Settings → Appearance overrides the system,
// survives a reload, and System follows the device as it changes.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, watchConsole, shot, assert, BASE, sleep } from './lib.mjs'

const { ctx, close } = await launch({ userDataDir: mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'gs-theme-')), colorScheme: 'light' })
const page = ctx.pages()[0] ?? (await ctx.newPage())
const errors = watchConsole(page)
const state = () =>
  page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    paper: getComputedStyle(document.body).backgroundColor,
    bar: document.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
  }))
const pick = (label) => page.tap(`.appearance-card [role="radio"]:has-text("${label}")`)

await page.goto(BASE + '/')
await page.waitForSelector('.outline .row')
assert((await state()).theme === 'light', 'light, like the system')

await page.goto(BASE + '/#/settings')
await page.waitForSelector('.appearance-card')
assert((await page.getAttribute('.appearance-card [aria-checked="true"]', 'role')) === 'radio', 'one choice is on')
assert((await page.innerText('.appearance-card [aria-checked="true"]')).trim() === 'System', 'System to start')
await pick('Dark')
await sleep(200)
let s = await state()
assert(s.theme === 'dark' && s.paper === 'rgb(15, 43, 71)' && s.bar === '#0f2b47', 'Dark overrides a light system: ' + JSON.stringify(s))
await shot(page, 'theme-dark-settings')

// Set before the first paint on the next load.
await page.reload()
s = await state()
assert(s.theme === 'dark' && s.bar === '#0f2b47', 'still dark after a reload: ' + JSON.stringify(s))

// System follows the device, as it changes.
await page.waitForSelector('.appearance-card')
await pick('System')
await sleep(200)
assert((await state()).theme === 'light', 'System: light again')
await page.emulateMedia({ colorScheme: 'dark' })
await sleep(200)
assert((await state()).theme === 'dark', 'System: dark when the device goes dark')

// Light overrides a dark system.
await pick('Light')
await sleep(200)
s = await state()
assert(s.theme === 'light' && s.paper === 'rgb(244, 247, 248)' && s.bar === '#f4f7f8', 'Light overrides a dark system: ' + JSON.stringify(s))

console.log('console errors:', errors.length ? errors : 'none')
await close()
if (errors.length) process.exit(1)
