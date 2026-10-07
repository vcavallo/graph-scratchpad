// The installed app notices a new deploy and offers a reload; Settings → About
// can look on demand ("Check for updates").
// Usage: node e2e/update.mjs   (against the deploy server on 127.0.0.1:8742)
import { launch, assert, sleep, watchConsole } from './lib.mjs'
import { execSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.DEPLOY_URL ?? 'http://127.0.0.1:8742'
const { ctx, close } = await launch({ userDataDir: mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'gs-upd-')) })
const page = ctx.pages()[0] ?? (await ctx.newPage())
const errors = watchConsole(page)
await page.goto(BASE + '/#/settings?tab=about')
await page.evaluate(() => navigator.serviceWorker.ready)
await sleep(800)
const version = () => page.locator('dt:has-text("Version") + dd').textContent()
const before = await version()
console.log('  running:', before)

execSync('node scripts/deploy.mjs', { stdio: 'ignore' }) // same build: no update expected
await page.tap('button:has-text("Check for updates")')
await page.waitForSelector('.toast:has-text("You’re up to date")', { timeout: 15000 })
assert(!(await page.isVisible('.banner-update')), 'Check for updates: up to date, no banner')
execSync('npx vite build && node scripts/deploy.mjs', { stdio: 'ignore' }) // new build time → new bundle
await sleep(1500)
await page.tap('button:has-text("Check for updates")')
await page.waitForSelector('.banner-update', { timeout: 20000 })
const said = await page.waitForSelector('.toast:has-text("new version"), .toast:has-text("up to date")', { timeout: 20000 }).then((t) => t.textContent())
assert(said.includes('A new version is ready'), 'Check for updates finds the new deploy, and the banner appears: ' + said)
const origin0 = await page.evaluate(() => performance.timeOrigin)
await page.tap('.banner-update button')
let after = before
for (let i = 0; i < 40 && after === before; i++) {
  await sleep(250)
  try {
    after = (await version()) ?? before
  } catch {
    // mid-reload
  }
}
console.log('  page reloaded:', (await page.evaluate(() => performance.timeOrigin)) !== origin0)
console.log('  now running:', after)
assert(after !== before, 'reload switches to the new version')
console.log('console errors:', errors.length ? errors : 'none')
await close()
