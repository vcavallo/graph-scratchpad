// To-dos vs plain bullets: typed markers, inheritance, paste, progress, counts,
// and "things linked here" (a "waiting" state you link to-dos to).
import { launch, watchConsole, shot, outline, activeRowText, assert, BASE, sleep } from './lib.mjs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { ctx, close } = await launch({ userDataDir: mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'gs-todo-')) })
const page = ctx.pages()[0] ?? (await ctx.newPage())
const errors = watchConsole(page)
const hasCheck = (text) => page.isVisible(`.row:has-text("${text}") .check`)
const paste = (text) =>
  page.evaluate((t) => {
    const dt = new DataTransfer()
    dt.setData('text/plain', t)
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, text)
const padMeta = (name) => page.innerText(`.list-item:has-text("${name}") .list-meta`)

async function newPad(title) {
  await page.goto(BASE + '/#/pads')
  await page.tap('text=New pad')
  await page.waitForSelector('.editable.title')
  await sleep(200)
  await page.keyboard.type(title)
  await page.keyboard.press('Enter')
  await sleep(150)
}

async function openPad(name) {
  await page.goto(BASE + '/#/pads')
  await page.tap(`.list-item:has-text("${name}") .list-main`)
  await page.waitForSelector('.outline .row')
  await sleep(300)
}

await page.goto(BASE + '/')
await page.waitForSelector('.outline .row')
await sleep(300)
assert(!(await hasCheck('Tap any line')), 'welcome notes have no checkbox')
assert(await hasCheck('Fix the sprinkler'), 'welcome to-dos have one')
assert((await page.innerText('.row:has-text("Fix the sprinkler") .row-progress')) === '0/2', 'a parent shows its progress')

// A new pad starts as a checklist, and Enter keeps it one.
await newPad('Groceries')
await page.keyboard.type('milk')
assert(await hasCheck('milk'), 'the first line of a pad is a to-do')
await page.keyboard.press('Enter')
await page.keyboard.type('eggs')
assert(await hasCheck('eggs'), 'Enter continues a checklist')

// Markdown-style markers typed at the start switch the line.
await page.keyboard.press('Enter')
await page.keyboard.type('- ')
await sleep(100)
assert(!(await page.isVisible('.row.active .check')), 'typing "- " makes a bullet')
assert((await activeRowText(page)) === '', 'the marker itself is removed')
await page.keyboard.type('get the good bread')
await page.keyboard.press('Enter')
await page.keyboard.type('organic if it looks ok')
assert(!(await hasCheck('organic')), 'Enter after a bullet makes a bullet')
await page.keyboard.press('Enter')
await page.keyboard.type('[] butter')
await sleep(100)
assert(await hasCheck('butter'), 'typing "[] " makes a to-do')
assert((await activeRowText(page)) === 'butter', 'and drops the brackets')

// "1. " at the start of a line numbers the list it's in.
await newPad('Steps')
await page.keyboard.type('1. Unplug it')
await sleep(300)
assert((await activeRowText(page)) === 'Unplug it', 'the number itself is removed')
await page.keyboard.press('Enter')
await page.keyboard.type('Open the case')
await sleep(300)
const nums = await page.$$eval('.outline .row .bullet .num', (els) => els.map((e) => e.textContent))
assert(JSON.stringify(nums) === JSON.stringify(['1.', '2.']), 'the list is numbered: ' + JSON.stringify(nums))
await openPad('Groceries')
await page.tap('.row:has-text("butter") .row-text')
await page.keyboard.press('End')

// Desktop shortcut: Ctrl+Shift+Enter switches; Ctrl+Enter still checks off.
await page.keyboard.press('Control+Shift+Enter')
await sleep(100)
assert(!(await hasCheck('butter')), 'Ctrl+Shift+Enter makes it a bullet')
await page.keyboard.press('Control+Shift+Enter')
await sleep(100)
assert(await hasCheck('butter'), 'and a to-do again')

// Pasted checklists keep their boxes; plain lines follow the line before them.
await page.keyboard.press('Enter')
await paste('- [ ] jam\n- [x] tea\nhoney')
await sleep(500)
const rows = await outline(page)
assert(
  JSON.stringify(rows.slice(-3)) === JSON.stringify(['jam', 'tea ✓', 'honey']),
  'pasted [x] arrives checked off: ' + JSON.stringify(rows),
)
assert((await hasCheck('jam')) && (await hasCheck('honey')), 'pasted lines without a box follow the to-do they were pasted into')

await page.tap('.row:has-text("milk") .check')
await page.tap('[aria-label="Hide keyboard"]').catch(() => {})
await sleep(600)
await shot(page, 'todos-outline')

// Counts only count to-dos.
await page.goto(BASE + '/#/pads')
await page.waitForSelector('.list-item')
await sleep(300)
assert((await padMeta('Groceries')) === '4 open of 6', 'pad list counts to-dos only: ' + (await padMeta('Groceries')))

// The page menu turns every line into a to-do.
await openPad('Groceries')
await page.tap('[aria-label="More"]')
await page.tap('text=Add checkboxes to this list')
await sleep(500)
const checks = await page.$$eval('.outline .row', (rs) => rs.map((r) => !!r.querySelector('.check')))
assert(checks.length === 8 && checks.every(Boolean), 'every line now has a checkbox: ' + JSON.stringify(checks))
await page.goto(BASE + '/#/pads')
await page.waitForSelector('.list-item')
await sleep(300)
assert((await padMeta('Groceries')) === '6 open of 8', 'counts follow: ' + (await padMeta('Groceries')))

// A "waiting" state: a plain line in a States pad that to-dos link to.
await newPad('States')
await page.keyboard.type('- waiting')
await page.tap('[aria-label="Hide keyboard"]').catch(() => {})
await sleep(600)
await openPad('Groceries')
await page.tap('.row:has-text("eggs") .row-text')
await sleep(150)
await page.keyboard.press('End')
await page.keyboard.type(' @')
await page.waitForSelector('.picker')
await page.keyboard.type('waiting')
await sleep(300)
await page.tap('.picker-item:has-text("waiting")')
await sleep(300)
assert((await outline(page)).some((r) => r.startsWith('eggs [waiting]')), 'eggs links to waiting: ' + JSON.stringify(await outline(page)))
await page.tap('[aria-label="Hide keyboard"]').catch(() => {})
await sleep(700)

await openPad('States')
assert((await page.innerText('.row:has-text("waiting") .row-links')).trim() === '1', 'the waiting row shows one thing linked here')
await shot(page, 'states-pad')
await page.tap('.row:has-text("waiting") .row-links')
await page.waitForSelector('.backlinks')
await sleep(300)
const linksFirst = await page.evaluate(() => {
  const b = document.querySelector('.backlinks')
  const o = document.querySelector('.outline')
  return !!b && !!o && !!(b.compareDocumentPosition(o) & Node.DOCUMENT_POSITION_FOLLOWING)
})
assert(linksFirst, 'a line with nothing inside leads with what links here')
assert((await page.innerText('.backlinks .section-title')).startsWith('Linked here'), 'section is called Linked here')
assert((await page.innerText('.backlink')).includes('Groceries'), 'the linked to-do shows where it lives')
await shot(page, 'waiting-page')

// Checking it off from there: it's no longer waiting.
await page.tap('.backlink:has-text("eggs") .check')
await sleep(400)
assert((await page.innerText('.backlinks .count')) === '1 done', 'checked off from the waiting page')
await openPad('States')
assert(!(await page.isVisible('.row:has-text("waiting") .row-links')), 'finished to-dos stop counting')

console.log(errors.length ? 'console errors: ' + errors.join('\n') : 'console errors: none')
await close()
if (errors.length) process.exit(1)
