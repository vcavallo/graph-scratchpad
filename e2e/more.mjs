// Android-style input events, paste, pads, move, trash, item view, second tab,
// offline, installability, dark mode.
import { launch, watchConsole, shot, outline, activeRowText, assert, BASE, sleep } from './lib.mjs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = process.env.TMPDIR ?? tmpdir()
const { ctx, close } = await launch({ userDataDir: mkdtempSync(join(tmp, 'gs-e2e-')) })
const page = ctx.pages()[0] ?? (await ctx.newPage())
const errors = watchConsole(page)

await page.goto(BASE + '/')
await page.waitForSelector('.outline .row')
await page.goto(BASE + '/#/pads')
await page.tap('text=New pad')
await page.waitForSelector('.editable.title')
await sleep(200)
await page.keyboard.type('Groceries')
await page.keyboard.press('Enter')
await page.keyboard.type('milk')

// Android keyboards often send keyCode 229 keydowns and rely on beforeinput.
const fire = (type) =>
  page.evaluate((t) => {
    const el = document.activeElement
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', keyCode: 229, bubbles: true, cancelable: true }))
    el.dispatchEvent(new InputEvent('beforeinput', { inputType: t, bubbles: true, cancelable: true }))
  }, type)
await fire('insertParagraph')
await sleep(150)
assert(JSON.stringify(await outline(page)) === '["milk",""]', 'beforeinput insertParagraph makes a new line')
await fire('deleteContentBackward')
await sleep(250)
assert(JSON.stringify(await outline(page)) === '["milk"]', 'beforeinput deleteContentBackward on empty line deletes it')
assert((await activeRowText(page)) === 'milk', 'focus back on previous line')

// Enter at the start of a non-empty line inserts a line above.
await page.keyboard.press('Home')
await page.keyboard.press('Enter')
await sleep(150)
assert(JSON.stringify(await outline(page)) === '["","milk"]', 'Enter at start inserts above')
assert((await activeRowText(page)) === 'milk', 'focus stays on the line')
await page.keyboard.press('ArrowUp')
await page.keyboard.type('eggs')

// Multi-line paste becomes several lines; list markers are stripped.
await page.evaluate(() => {
  const dt = new DataTransfer()
  dt.setData('text/plain', 'bread\n- butter\n* [ ] jam\n\ncoffee')
  document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
})
await sleep(400)
assert(
  JSON.stringify(await outline(page)) === '["eggsbread","butter","jam","coffee","milk"]',
  'paste splits lines: ' + JSON.stringify(await outline(page)),
)
assert((await activeRowText(page)) === 'coffee', 'focus on last pasted line')
const groceries = page.url()

// Move an item to another pad via the More sheet.
await page.tap('[aria-label="More actions"]')
await page.tap('.sheet-action:has-text("Move to")')
await page.waitForSelector('.picker')
await sleep(250)
await page.tap('.picker-trail button:has-text("All pads")')
await sleep(250)
await page.tap('.picker-item:has-text("Welcome")')
await sleep(250)
assert(await page.isVisible('.picker'), 'tapping a pad opens it instead of moving')
await page.tap('.picker-here')
await sleep(500)
assert(!(await outline(page)).includes('coffee'), 'moved item left this pad')
assert(await page.isVisible('.toast:has-text("Moved to")'), 'toast confirms the move')
await page.tap('.toast-action:has-text("Undo")')
await sleep(500)
assert((await outline(page)).includes('coffee'), 'undo brings it back')

// Delete with undo and via trash.
await page.tap('.row:has-text("butter") .row-text')
await page.tap('[aria-label="More actions"]')
await page.tap('.sheet-action:has-text("Delete")')
await sleep(400)
assert(!(await outline(page)).includes('butter'), 'delete removes the line')
await page.tap('[aria-label="Hide keyboard"]')
await sleep(300)
await page.goto(BASE + '/#/trash')
await page.waitForSelector('.list-item')
assert((await page.innerText('.list-item')).includes('butter'), 'deleted line is in trash')
await page.tap('.list-item button:has-text("Restore")')
await sleep(400)
await page.goto(groceries)
await page.waitForSelector('.outline .row')
await sleep(300)
assert((await outline(page)).includes('butter'), 'restored from trash')

// Item view: inline children, title checkbox, outdent disabled at the view root.
await page.tap('.row:has-text("milk") .bullet')
await page.waitForSelector('.title-block .check.big')
await page.tap('.add-row')
await page.keyboard.type('oat')
await page.keyboard.press('Enter')
await page.keyboard.type('whole')
await sleep(150)
assert(await page.isDisabled('[aria-label="Outdent"]'), 'cannot outdent past the viewed item')
await page.tap('[aria-label="Hide keyboard"]')
await page.tap('.title-block .check.big')
await sleep(400)
assert(await page.isVisible('.title-block.done'), 'title checkbox marks the item done')
await shot(page, 'item-view')
await page.tap('.back')
await page.waitForSelector('.outline .row')
await sleep(300)
const rows = await outline(page)
assert(rows.includes('milk ✓') && rows.includes('  oat') && rows.includes('  whole'), 'children and done state show in the pad: ' + JSON.stringify(rows))

// Pads: reorder via the sheet.
await page.goto(BASE + '/#/pads')
await page.waitForSelector('.list-item')
const padNames = () => page.$$eval('.list-item .list-label', (e) => e.map((x) => x.textContent))
const before = await padNames()
await page.tap(`.list-item:has-text("${before[1]}") .icon-btn`)
await page.tap('.sheet-action:has-text("Move up")')
await sleep(400)
const after = await padNames()
assert(after[0] === before[1] && after[1] === before[0], 'pad moved up: ' + JSON.stringify(after))
await shot(page, 'pads')

// A second tab waits for the first instead of corrupting the database.
const tab2 = await ctx.newPage()
await tab2.goto(BASE + '/#/pads')
await sleep(1500)
assert(await tab2.isVisible('text=open in another tab'), 'second tab shows the waiting message')
await tab2.close()

// Offline: reload with the network off; the service worker serves the shell.
await page.goto(BASE + '/#/pads')
await page.evaluate(() => navigator.serviceWorker.ready)
await sleep(500)
await ctx.setOffline(true)
await page.reload()
await page.waitForSelector('.list-item', { timeout: 10000 })
assert((await padNames()).length === 2, 'app loads offline with data')
await page.goto(groceries)
await page.waitForSelector('.outline .row')
assert((await outline(page)).includes('butter'), 'pads open offline')
await ctx.setOffline(false)

// Installability (manifest, icons, service worker).
const cdp = await ctx.newCDPSession(page)
const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors')
assert(installabilityErrors.length === 0, 'no installability errors: ' + JSON.stringify(installabilityErrors))
const manifest = await cdp.send('Page.getAppManifest')
assert(!manifest.errors?.length, 'manifest parses cleanly')

console.log('console errors:', errors.length ? errors : 'none')
await close()

// Dark mode look.
const dark = await launch({ colorScheme: 'dark', userDataDir: mkdtempSync(join(tmp, 'gs-e2e-')) })
const dp = dark.ctx.pages()[0] ?? (await dark.ctx.newPage())
await dp.goto(BASE + '/')
await dp.waitForSelector('.outline .row')
await sleep(600)
await shot(dp, 'dark-welcome')
await dp.tap('.row:nth-child(3) .row-text')
await sleep(300)
await shot(dp, 'dark-editing')
await dark.close()
