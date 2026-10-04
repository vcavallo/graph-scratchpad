// Interactive graph: tap to focus, drag to move, back steps through focus.
import { launch, watchConsole, shot, assert, BASE, sleep } from './lib.mjs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { ctx, close } = await launch({ userDataDir: mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'gs-graph-')) })
const page = ctx.pages()[0] ?? (await ctx.newPage())
const errors = watchConsole(page)
await page.goto(BASE + '/')
await page.waitForSelector('.outline .row')
await page.tap('[aria-label="Show graph"]')
await page.waitForSelector('.gnode.center')
await sleep(500)
const focusLabel = () => page.textContent('.focus-card .focus-label')
assert((await focusLabel()) === 'Welcome', 'focus card shows the starting node')
await page.tap('.segmented button:has-text("3 steps")')
await page.waitForSelector('.gnode.kind-place')
await sleep(900)
await shot(page, 'graph-start')

// Tap the place node: it becomes the focus, the card updates, the URL records it.
await page.tap('.gnode.kind-place')
await sleep(900)
assert((await focusLabel()) === 'Hardware store', 'tapping a node focuses it: ' + (await focusLabel()))
assert(await page.isVisible('.gnode.center.kind-place'), 'the focused node is drawn as the centre')
assert(page.url().includes('/graph') && page.url().includes('focus='), 'still on the graph, focus in the URL')
await shot(page, 'graph-refocused')

// Drag a node: it moves and does not change focus.
const target = await page.$('.gnode:not(.center)')
const pos = async (el) => el.evaluate((g) => g.getAttribute('transform'))
const before = await pos(target)
const box = await target.$eval('circle.disc', (c) => {
  const r = c.getBoundingClientRect()
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
})
await page.mouse.move(box.x, box.y)
await page.mouse.down()
for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + i * 8, box.y + i * 12)
await page.mouse.up()
await sleep(300)
const after = await pos(target)
assert(before !== after, 'dragging moves the node')
assert((await focusLabel()) === 'Hardware store', 'dragging does not change focus')

// Back steps to the previous focus.
await page.goBack()
await sleep(900)
assert((await focusLabel()) === 'Welcome', 'back returns to the previous focus')

// Open goes to the text page.
await page.tap('.focus-card button:has-text("Open")')
await page.waitForSelector('.editable.title')
assert(!page.url().includes('graph'), 'Open leaves the graph for the node page')
console.log('console errors:', errors.length ? errors : 'none')
await close()
