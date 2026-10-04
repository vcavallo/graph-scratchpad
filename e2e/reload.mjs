// Rapid reloads must never lose the database. After a reload the previous
// worker can still hold the OPFS file handles for a moment; sqlite-wasm's
// opfs-sahpool deletes its whole pool if opening fails, so the worker waits
// for the handles and blocks deletions while opening (see worker.ts).
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, watchConsole, outline, assert, BASE, sleep } from './lib.mjs'

const { ctx, close } = await launch({ userDataDir: mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'gs-reload-')) })
const page = ctx.pages()[0] ?? (await ctx.newPage())
const errors = watchConsole(page)

await page.goto(BASE + '/#/pads')
await page.tap('text=New pad')
await page.waitForSelector('.editable.title')
await sleep(200)
await page.keyboard.type('Keep me')
await page.keyboard.press('Enter')
await page.keyboard.type('precious line')
await page.tap('[aria-label="Hide keyboard"]')
await sleep(800)
const url = page.url()

let lost = 0
let memory = 0
for (let round = 0; round < 12; round++) {
  // Reload again before the previous load has settled, at varying moments.
  await page.goto(url, { waitUntil: 'commit' })
  await sleep(30 + ((round * 37) % 250))
  await page.goto(url, { waitUntil: 'commit' })
  await page.waitForSelector('.outline .row, .empty-state, .banner-danger', { timeout: 15000 })
  await sleep(300)
  if (await page.isVisible('.banner-danger')) memory++
  if (!(await outline(page)).includes('precious line')) lost++
}
assert(memory === 0, `the database opened every time (in-memory fallbacks: ${memory})`)
assert(lost === 0, `nothing was lost across 24 quick reloads (losses: ${lost})`)

// Now force the race: another tab's worker holds one of the pool's files (not
// the database itself) while the app starts, as a dying worker would.
const HOLDER = `
  onmessage = async (e) => {
    const root = await navigator.storage.getDirectory()
    const dir = await (await root.getDirectoryHandle('.graph-scratchpad')).getDirectoryHandle('.opaque')
    let held = null
    for await (const h of dir.values()) {
      if (h.kind !== 'file') continue
      const ah = await h.createSyncAccessHandle()
      const head = new Uint8Array(64)
      ah.read(head, { at: 0 })
      const name = new TextDecoder().decode(head).split('\\0')[0]
      if (name === '/scratchpad.sqlite3' || held) ah.close()
      else held = ah
    }
    postMessage(held ? 'held' : 'nothing to hold')
    setTimeout(() => { held?.close(); postMessage('released') }, e.data)
  }`

async function holdFor(ms) {
  const helper = await ctx.newPage()
  await helper.goto(BASE + '/manifest.webmanifest')
  const state = await helper.evaluate(
    ([src, ms]) =>
      new Promise((resolve) => {
        const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })))
        globalThis.holder = w
        w.onmessage = (e) => resolve(e.data)
        w.postMessage(ms)
      }),
    [HOLDER, ms],
  )
  return { helper, state }
}

await page.close()
await sleep(800)

// Held for 2 s: the app waits for the file, then opens normally.
let { helper, state } = await holdFor(2000)
assert(state === 'held', 'another tab holds one of the database’s files')
let app = await ctx.newPage()
await app.goto(url)
await app.waitForSelector('.outline .row, .banner-danger', { timeout: 20000 })
await sleep(300)
assert(!(await app.isVisible('.banner-danger')), 'the app waits for the file and opens the database')
assert((await outline(app)).includes('precious line'), 'with everything in it')
await app.close()
await helper.close()
await sleep(800)

// Held for longer than the app waits: it falls back to memory, but deletes nothing.
;({ helper, state } = await holdFor(14000))
app = await ctx.newPage()
await app.goto(url)
await app.waitForSelector('.banner-danger', { timeout: 30000 })
assert(true, 'held too long: the app warns that it isn’t saving')
await app.close()
await helper.close()
await sleep(1000)
app = await ctx.newPage()
await app.goto(url)
await app.waitForSelector('.outline .row', { timeout: 20000 })
await sleep(300)
assert((await outline(app)).includes('precious line'), 'and once the file is free, the data is all still there')

console.log('console errors:', errors.length ? errors : 'none')
await close()
