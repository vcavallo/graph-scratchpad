// Your relations: keep a suggested label, fold another wording into it, label
// a single link, and see a relation's page.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, watchConsole, shot, assert, BASE, sleep } from './lib.mjs'

const { ctx, close } = await launch({ userDataDir: mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'gs-rel-')) })
const page = ctx.pages()[0] ?? (await ctx.newPage())
const errors = watchConsole(page)
const chips = () => page.$$eval('.rel-chip', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()))
const labels = () => page.$$eval('.backlink .rel', (els) => els.map((e) => e.textContent.trim()).sort())
const sheet = (text) => page.tap(`.sheet-action:has-text("${text}")`)

async function openStore() {
  await page.goto(BASE + '/#/places')
  await page.tap('.list-item:has-text("Hardware store") .list-main')
  await page.waitForSelector('.backlinks')
  await sleep(300)
}

// The welcome pad links to the Hardware store twice, worded differently.
await page.goto(BASE + '/')
await page.waitForSelector('.outline .row')
await openStore()
assert(JSON.stringify(await chips()) === JSON.stringify(['All 2', 'buy at 1', 'pick up at 1']), 'two suggestions: ' + JSON.stringify(await chips()))
assert((await page.$$('.backlink .rel.suggested')).length === 2, 'suggested labels are drawn outlined')

// Keep "buy at".
await page.tap('.rel-chip:has-text("buy at")')
await page.waitForSelector('.rel-bar')
await page.tap('.rel-bar button')
await sheet('Keep “buy at”')
await sleep(400)
assert(!(await page.isVisible('.backlink:has-text("PVC") .rel.suggested')), 'a kept relation is drawn solid')

// Fold "pick up at" into it, from the label on that line.
await page.tap('.rel-chip:has-text("All")')
await page.tap('.backlink:has-text("teflon") .rel')
await sheet('Call it something else')
await page.waitForSelector('.picker')
await page.keyboard.type('buy')
await sleep(300)
await page.tap('.picker-item:has-text("buy at")')
await sleep(500)
assert(JSON.stringify(await labels()) === JSON.stringify(['buy at', 'buy at']), 'both lines are “buy at” now: ' + JSON.stringify(await labels()))
assert(!(await page.isVisible('.rel-chips')), 'one kind of link: no chips needed')
await shot(page, 'relations-store')

// Label one link by hand, with a new relation.
await page.tap('.backlink:has-text("teflon") .rel')
await sheet('Label just this link')
await page.waitForSelector('.picker')
await page.keyboard.type('stock up at')
await sleep(300)
await page.tap('text=New relation “stock up at”')
await sleep(500)
assert(JSON.stringify(await labels()) === JSON.stringify(['buy at', 'stock up at']), 'that one link is labelled by hand: ' + JSON.stringify(await labels()))

// The Relations screen and a relation's page.
await page.goto(BASE + '/#/settings')
await page.tap('text=What your links mean')
await page.waitForSelector('.relations-page')
await sleep(300)
const mine = await page.$$eval('.relations-page .list-item', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()))
assert(mine.some((t) => t.startsWith('buy at') && t.includes('also pick up at') && t.endsWith('1 link')), 'Relations lists “buy at” with its other wording: ' + JSON.stringify(mine))
assert(mine.some((t) => t.startsWith('stock up at') && t.endsWith('1 link')), 'and the hand-made one')
await shot(page, 'relations-list')
await page.tap('.list-item:has-text("buy at") .list-main')
await page.waitForSelector('.relation-links')
await sleep(300)
assert((await page.innerText('.rel-group-head')).includes('Hardware store'), 'a relation’s page groups its links by what they link to')
assert((await page.innerText('.outline')).includes('pick up at'), 'and lists the other ways you write it')
await shot(page, 'relation-page')

// Rename it: the labels follow.
await page.tap('[aria-label="More"]')
await sheet('Rename')
await page.waitForSelector('.dialog-input')
await page.fill('.dialog-input', 'shop at')
await page.tap('.dialog .btn-primary')
await sleep(400)
assert((await page.innerText('.static-title')) === 'shop at', 'renamed')
await openStore()
assert(JSON.stringify(await labels()) === JSON.stringify(['shop at', 'stock up at']), 'labels follow the rename: ' + JSON.stringify(await labels()))

console.log('console errors:', errors.length ? errors : 'none')
await close()
if (errors.length) process.exit(1)
