// Two devices (separate browser profiles) syncing through the real server:
// first-run join, live updates, and edits made while the server was down.
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, watchConsole, shot, outline, assert, sleep } from './lib.mjs'

const tmp = process.env.TMPDIR ?? tmpdir()
const dir = mkdtempSync(join(tmp, 'gs-sync-'))
const PORT = 4177
const BASE = `http://localhost:${PORT}`
const repo = new URL('..', import.meta.url).pathname

let server
function startServer() {
  server = spawn('node', [join(repo, 'server/serve.mjs'), join(repo, 'dist'), String(PORT)], {
    env: { ...process.env, SYNC_DB: join(dir, 'sync.sqlite3'), SYNC_NAME: 'test-server', NODE_NO_WARNINGS: '1' },
    stdio: 'ignore',
  })
}
async function stopServer() {
  server.kill()
  await new Promise((r) => server.once('exit', r))
}
const serverInfo = async () => (await fetch(BASE + '/api/sync')).json()

/** Poll until fn() is truthy (or fail with the last value). */
async function until(fn, msg, ms = 8000) {
  const end = Date.now() + ms
  let last
  while (Date.now() < end) {
    last = await fn()
    if (last) {
      console.log('  ok -', msg)
      return last
    }
    await sleep(150)
  }
  assert(false, `${msg} (last: ${JSON.stringify(last)})`)
}

startServer()
await sleep(600)

const A = await launch({ userDataDir: mkdtempSync(join(tmp, 'gs-sync-a-')) })
const B = await launch({ userDataDir: mkdtempSync(join(tmp, 'gs-sync-b-')) })
const a = A.ctx.pages()[0] ?? (await A.ctx.newPage())
const b = B.ctx.pages()[0] ?? (await B.ctx.newPage())
const errA = watchConsole(a, 'A')
const errB = watchConsole(b, 'B')

try {
  // Device A: first ever. The server is empty, so A gets the welcome pad, and
  // turns sync on by itself.
  await a.goto(BASE + '/')
  await a.waitForSelector('.outline .row')
  await until(() => a.isVisible('.toast:has-text("Syncing with test-server")'), 'A says it is syncing')

  // A makes a list.
  await a.goto(BASE + '/#/pads')
  await a.tap('text=New pad')
  await a.waitForSelector('.editable.title')
  await sleep(200)
  await a.keyboard.type('Shared')
  await a.keyboard.press('Enter')
  await a.keyboard.type('milk')
  await a.keyboard.press('Enter')
  await a.keyboard.type('eggs')
  await a.tap('[aria-label="Hide keyboard"]')
  await until(async () => (await serverInfo()).nodes >= 3, 'A’s pad reaches the server')
  assert((await serverInfo()).nodes === 3, 'the untouched welcome pad stays on A')

  // Device B: fresh. It pulls before deciding what to show, so no welcome pad.
  await b.goto(BASE + '/')
  await b.waitForSelector('.outline .row')
  await sleep(300)
  assert(JSON.stringify(await outline(b)) === JSON.stringify(['milk', 'eggs']), 'B opens on A’s pad: ' + JSON.stringify(await outline(b)))
  await b.goto(BASE + '/#/pads')
  await b.waitForSelector('.list-item')
  const padsB = await b.$$eval('.list-item .list-label', (els) => els.map((e) => e.textContent))
  assert(JSON.stringify(padsB) === JSON.stringify(['Shared']), 'B has just the shared pad: ' + JSON.stringify(padsB))
  await b.tap('.list-item:has-text("Shared") .list-main')
  await b.waitForSelector('.outline .row')

  // Live: B checks off milk; A, looking at the same pad, sees it without reloading.
  await a.goto(BASE + '/#/pads')
  await a.tap('.list-item:has-text("Shared") .list-main')
  await a.waitForSelector('.outline .row')
  await b.tap('.row:has-text("milk") .check')
  await until(async () => (await outline(a)).includes('milk ✓'), 'A sees B check off milk')

  // The server goes away; both devices keep working.
  await stopServer()
  await a.tap('.row:has-text("eggs") .row-text')
  await a.keyboard.press('End')
  await a.keyboard.type(' (a dozen)')
  await a.tap('[aria-label="Hide keyboard"]')
  await b.tap('.add-row')
  await b.keyboard.type('bread')
  await b.tap('[aria-label="Hide keyboard"]')
  await sleep(1800)
  await b.goto(BASE + '/#/settings')
  await until(async () => (await b.innerText('.sync-card')).includes('Can’t reach the server'), 'B says it can’t reach the server')
  await shot(b, 'sync-offline')

  // Back up: everything merges, on both.
  startServer()
  await sleep(600)
  await b.tap('.sync-card button:has-text("Sync now")')
  await until(async () => (await b.innerText('.sync-card')).includes('Up to date'), 'B syncs once the server is back')
  await shot(b, 'sync-settings')
  await b.goBack()
  const want = JSON.stringify(['milk ✓', 'eggs (a dozen)', 'bread'])
  await until(async () => JSON.stringify(await outline(a)) === want, 'A has both devices’ edits', 15000)
  await b.reload()
  await b.waitForSelector('.outline .row')
  await until(async () => JSON.stringify(await outline(b)) === want, 'B has both devices’ edits')
} finally {
  const errs = [...errA, ...errB].filter((e) => !/Failed to load resource|ERR_CONNECTION_REFUSED|EventSource/.test(e))
  console.log('console errors:', errs.length ? errs : 'none')
  await A.close()
  await B.close()
  server.kill()
  if (errs.length) process.exitCode = 1
}
