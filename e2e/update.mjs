// The installed app notices a new deploy and offers a reload.
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
execSync('npx vite build && node scripts/deploy.mjs', { stdio: 'ignore' }) // new build time → new bundle
await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.update())
await page.waitForSelector('.banner-update', { timeout: 15000 })
assert(true, 'update banner appears after a new deploy')
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
