// Rough performance check: a large pad loads and stays responsive.
import { launch, assert, BASE, sleep } from './lib.mjs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { ctx, close } = await launch({ userDataDir: mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'gs-perf-')) })
const page = ctx.pages()[0] ?? (await ctx.newPage())
await page.goto(BASE + '/')
await page.waitForSelector('.outline .row')

// Build a 400-item pad through an import file (fast) with 3 levels of nesting.
const now = Date.now()
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const nodes = [{ id: id(0), kind: 'pad', text: 'Big', done: 0, collapsed: 0, created_at: now, updated_at: now, deleted_at: null, sort_key: 'a0' }]
const edges = []
nodes.push({ id: id(9999), kind: 'place', text: 'Store', done: 0, collapsed: 0, created_at: now, updated_at: now, deleted_at: null, sort_key: null })
for (let i = 1; i <= 400; i++) {
  const parent = i % 10 === 1 ? id(0) : i % 5 === 1 ? id(i - (i % 10) + 1) : id(i - ((i - 1) % 5))
  const text = i % 7 === 0 ? `item ${i} at [[${id(9999)}]]` : `item ${i} with some ordinary words in it`
  nodes.push({ id: id(i), kind: 'item', text, done: i % 3 === 0 ? 1 : 0, collapsed: 0, created_at: now, updated_at: now, deleted_at: null, sort_key: null })
  edges.push({ id: `e-${i}`, src: parent === id(i) ? id(0) : parent, dst: id(i), type: 'child', sort_key: `a${String(i).padStart(4, '0')}`, created_at: now })
  if (i % 7 === 0) edges.push({ id: `l-${i}`, src: id(i), dst: id(9999), type: 'link', sort_key: null, created_at: now })
}
const { writeFileSync } = await import('node:fs')
const f = join(process.env.TMPDIR ?? tmpdir(), 'gs-big.json')
writeFileSync(f, JSON.stringify({ app: 'graph-scratchpad', format: 1, schema_version: 2, exported_at: now, nodes, edges }))
await page.goto(BASE + '/#/settings')
const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.tap('button:has-text("Import")')])
await chooser.setFiles(f)
await page.tap('.dialog button:has-text("Replace")')
await page.waitForSelector('.outline .row')

await page.goto(BASE + '/#/pads')
await page.waitForSelector('.list-item')
const t0 = Date.now()
await page.tap('.list-item:has-text("Big") .list-main')
await page.waitForFunction(() => document.querySelectorAll('.outline .row').length >= 400)
const loadMs = Date.now() - t0
const rows = await page.$$eval('.outline .row', (r) => r.length)
assert(rows === 400, `rendered ${rows} rows`)
console.log(`  load+render 400 rows: ${loadMs} ms`)
assert(loadMs < 3000, 'loads in under 3s')

// Typing latency: keystrokes in a row while saves and reloads happen.
await page.tap('.row:nth-child(200) .row-text')
await page.keyboard.press('End')
const t1 = Date.now()
await page.keyboard.type(' quick brown fox jumps', { delay: 30 })
const typeMs = Date.now() - t1 - 22 * 30
console.log(`  typing overhead for 22 keys: ${typeMs} ms`)
const t2 = Date.now()
await page.keyboard.press('Enter')
await page.waitForFunction(() => document.querySelectorAll('.outline .row').length === 401)
console.log(`  Enter → new row visible: ${Date.now() - t2} ms`)
await sleep(1200)
const t3 = Date.now()
await page.tap('[aria-label="Indent"]')
await sleep(50)
console.log(`  indent tap handled: ${Date.now() - t3} ms`)
const backlinkT = Date.now()
await page.goto(BASE + `/#/n/${id(9999)}`)
await page.waitForSelector('.backlink')
console.log(`  place view with ${await page.$$eval('.backlink', (b) => b.length)} open backlinks: ${Date.now() - backlinkT} ms`)
await close()
