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
const box = await target.$eval('.disc', (c) => {
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
// Numbered lists: numbers in the outline, an ordered column in the graph.
await page.goto(BASE + '/')
await page.waitForSelector('.outline .row')
await page.tap('.row:has-text("Fix the sprinkler") .row-text')
await page.keyboard.press('End')
await page.keyboard.press('Enter')
await page.keyboard.type('Dig out the broken head')
await sleep(300)
await page.tap('.row:has-text("Fix the sprinkler") .row-text')
await page.tap('[aria-label="More actions"]')
await page.tap('.sheet-action:has-text("Number the items inside")')
await sleep(500)
const nums = await page.$$eval('.row.numbered .num', (n) => n.map((x) => x.textContent))
assert(JSON.stringify(nums) === '["1.","2.","3."]', 'children show numbers: ' + JSON.stringify(nums))
// Enter at the end of an expanded parent adds its first child.
assert((await page.$eval('.row.numbered:has-text("Dig out") .num', (n) => n.textContent)) === '1.', 'new first child is 1.')
await page.tap('.row:has-text("Dig out") .row-text')
await page.tap('[aria-label="Move down"]')
await sleep(300)
const movedNum = await page.$eval('.row.numbered:has-text("Dig out") .num', (n) => n.textContent)
assert(movedNum === '2.', 'numbers follow reordering: ' + movedNum)
await page.tap('[aria-label="Hide keyboard"]')
await sleep(400)
await page.tap('.row:has-text("Fix the sprinkler") .bullet')
await page.waitForSelector('.title-block')
await page.tap('[aria-label="Show graph"]')
await page.waitForSelector('.gnode.ordered')
await sleep(1200)
const col = await page.$$eval('.gnode.ordered', (gs) =>
  gs
    .map((g) => ({ n: Number(g.querySelector('text.num').textContent), y: g.getBoundingClientRect().y }))
    .sort((a, b) => a.n - b.n),
)
assert(col.length === 3 && col[0].y < col[1].y && col[1].y < col[2].y, 'numbered items stack in order: ' + JSON.stringify(col))
await shot(page, 'graph-numbered')

console.log('console errors:', errors.length ? errors : 'none')
await close()
