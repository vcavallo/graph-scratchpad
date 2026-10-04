// Regression checks for bugs found in review.
import { launch, watchConsole, outline, activeRowText, assert, BASE, sleep } from './lib.mjs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { ctx, close } = await launch({ userDataDir: mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'gs-reg-')) })
const page = ctx.pages()[0] ?? (await ctx.newPage())
const errors = watchConsole(page)
const errorToasts = () => page.$$eval('.toast.error', (t) => t.map((x) => x.innerText))
const paste = (text) =>
  page.evaluate((t) => {
    const dt = new DataTransfer()
    dt.setData('text/plain', t)
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, text)

await page.goto(BASE + '/')
await page.waitForSelector('.outline .row')
await page.goto(BASE + '/#/pads')
await page.tap('text=New pad')
await page.waitForSelector('.editable.title')
await sleep(200)
await page.keyboard.type('Probe')

// 5. Multi-line paste into a title: first line joins the title, the rest become items.
await paste('one\ntwo\nthree')
await sleep(400)
const titleText = (await page.innerText('.editable.title')).replace(/\u200B/g, '').trim()
assert(titleText === 'Probeone', 'title gets the first pasted line: ' + JSON.stringify(titleText))
assert(JSON.stringify(await outline(page)) === '["two","three"]', 'other lines become the first items: ' + JSON.stringify(await outline(page)))
assert((await activeRowText(page)) === 'three', 'focus on the last pasted item')

// 1. Pasting many lines keeps every row and focus.
const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n')
await paste(lines)
let minRows = Infinity
for (let i = 0; i < 20; i++) {
  minRows = Math.min(minRows, (await outline(page)).length)
  await sleep(25)
}
assert(minRows >= 13, `rows never vanish during a 12-line paste (min ${minRows})`)
await sleep(300)
assert((await outline(page)).length === 13, 'all pasted rows present (first line joins the current row)')
assert((await activeRowText(page)) === 'line 12', 'focus stays on the last pasted row: ' + (await activeRowText(page)))

// 2. Clearing a saved line with quick Backspaces deletes it without an error.
await page.keyboard.press('Enter')
await page.keyboard.type('milk')
await sleep(800)
for (let i = 0; i < 5; i++) await page.keyboard.press('Backspace')
await sleep(800)
assert(!(await outline(page)).includes('milk') && !(await outline(page)).includes(''), 'row deleted')
assert((await errorToasts()).length === 0, 'no error toast after deleting an edited row: ' + JSON.stringify(await errorToasts()))

// 3. Double Backspace at the start of a line merges once, without an error.
await page.keyboard.press('End')
await page.keyboard.press('Enter')
await page.keyboard.type('foo')
await page.keyboard.press('Enter')
await page.keyboard.type('bar')
await page.keyboard.press('Home')
await page.keyboard.press('Backspace')
await page.keyboard.press('Backspace')
await sleep(800)
const last = (await outline(page)).at(-1)
assert(last === 'foobar' || last === 'fobar', 'merged once: ' + last)
assert((await errorToasts()).length === 0, 'no error toast after double Backspace: ' + JSON.stringify(await errorToasts()))

// 4. Typing @ again after cancelling and deleting reopens the picker.
await page.keyboard.press('End')
await page.keyboard.press('Enter')
await page.keyboard.type('x @')
await page.waitForSelector('.picker')
await page.keyboard.press('Escape')
await sleep(200)
await page.keyboard.press('Backspace')
await page.keyboard.type('@')
await sleep(300)
assert(await page.isVisible('.picker'), 'picker reopens on a second @ at the same spot')
await page.keyboard.press('Escape')

console.log('console errors:', errors.length ? errors : 'none')
await close()
