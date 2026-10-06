// Vim keys: turn them on, then edit a list in normal and insert mode.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, watchConsole, shot, outline, activeRowText, assert, BASE, sleep } from './lib.mjs'

const { ctx, close } = await launch({ userDataDir: mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'gs-vim-')) })
const page = ctx.pages()[0] ?? (await ctx.newPage())
const errors = watchConsole(page)
const keys = async (...ks) => {
  for (const k of ks) await page.keyboard.press(k)
  await sleep(150)
}
const mode = () => page.innerText('.edit-toolbar .vim-mode')
const block = () => page.evaluate(() => document.getSelection()?.toString())
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

await page.goto(BASE + '/')
await page.waitForSelector('.outline .row')
await page.goto(BASE + '/#/settings')
await page.tap('text=Turn on Vim keys')
await page.waitForSelector('text=Turn off Vim keys')

await page.goto(BASE + '/#/pads')
await page.tap('text=New pad')
await page.waitForSelector('.editable.title')
await sleep(200)
await page.keyboard.type('Vim')
// Enter opens the first line, in insert mode.
await page.keyboard.press('Enter')
await sleep(200)
assert((await mode()) === 'Insert', 'a new line starts in insert mode')
const title = (await page.innerText('.editable.title')).replace(/\u200b/g, '').trim()
assert(title === 'Vim', 'a new pad’s name is typed in insert mode: ' + title)
await page.keyboard.type('buy elbows at the store')
await page.keyboard.press('Enter')
await page.keyboard.type('second line')
await keys('Escape')
assert((await mode()) === 'Normal', 'Esc: normal mode')
assert((await block()) === 'e', 'the cursor is a block on the last character: ' + JSON.stringify(await block()))

// Letters don't type in normal mode.
await keys('q', 'Q')
assert((await activeRowText(page)) === 'second line', 'nothing typed')

// k, 0, w, dw.
await keys('k', '0', 'w', 'd', 'w')
assert((await activeRowText(page)) === 'buy at the store', 'dw: ' + (await activeRowText(page)))
assert((await block()) === 'a', 'on the next word')
// $ a … Esc.
await keys('$', 'a')
await page.keyboard.type('!')
await keys('Escape')
assert((await activeRowText(page)) === 'buy at the store!', 'append at the end')

// o opens a line below; >> indents it.
await keys('o')
await page.keyboard.type('third')
await keys('Escape', '>', '>')
await sleep(300)
assert(same(await outline(page), ['buy at the store!', '  third', 'second line']), 'o and >>: ' + JSON.stringify(await outline(page)))

// j, then dd deletes the line; gg, then cc changes the first.
await keys('j', 'd', 'd')
await sleep(400)
assert(same(await outline(page), ['buy at the store!', '  third']), 'dd: ' + JSON.stringify(await outline(page)))
await keys('g', 'g', 'c', 'c')
await page.keyboard.type('replaced')
await keys('Escape', 'O')
await page.keyboard.type('above')
await keys('Escape')
await sleep(300)
assert(same(await outline(page), ['above', 'replaced', '  third']), 'cc and O: ' + JSON.stringify(await outline(page)))

// x, r, and d$ with Shift on the way.
await keys('j', '0', 'x', 'r', 'R', 'l', 'd', 'Shift+Digit4')
assert((await activeRowText(page)) === 'R', 'x, r, d$: ' + (await activeRowText(page)))
await shot(page, 'vim-normal')

// The mode button switches by tap too (for a phone with Vim keys on).
await page.tap('.edit-toolbar .vim-mode')
await sleep(150)
assert((await mode()) === 'Insert', 'tap: insert mode')
await keys('End')
await page.keyboard.type('ent')
assert((await activeRowText(page)) === 'Rent', 'typing works again: ' + (await activeRowText(page)))

// It's all saved.
await keys('Escape')
await sleep(800)
await page.reload()
await page.waitForSelector('.outline .row')
await sleep(500)
assert(same(await outline(page), ['above', 'Rent', '  third']), 'saved: ' + JSON.stringify(await outline(page)))

// yy p copies a line; u takes the copy away.
const rowIds = () => page.$$eval('.outline .row', (rs) => rs.map((r) => r.dataset.id))
const text = async () => (await outline(page)).map((t) => t.replace(/\s+$/, ''))
await page.tap('.row:has-text("above") .row-text')
await sleep(200)
await keys('y', 'y', 'p')
await sleep(400)
assert(same(await text(), ['above', 'above', 'Rent', '  third']), 'yy p: ' + JSON.stringify(await text()))
await keys('u')
await sleep(400)
assert(same(await text(), ['above', 'Rent', '  third']), 'u: ' + JSON.stringify(await text()))

// dd then p moves the line itself: a link to it still works.
await keys('A')
await page.keyboard.type(' see @')
await page.waitForSelector('.picker')
await page.keyboard.type('third')
await sleep(300)
await page.tap('.picker-item:has-text("third")')
await sleep(300)
await keys('Escape')
const thirdId = (await rowIds())[2]
await keys('j', 'j', 'd', 'd')
await sleep(400)
assert(same(await text(), ['above see [third]', 'Rent']), 'dd: ' + JSON.stringify(await text()))
await keys('p')
await sleep(500)
assert(same(await text(), ['above see [third]', 'Rent', 'third']), 'p after dd: ' + JSON.stringify(await text()))
assert((await rowIds())[2] === thirdId, 'it’s the same line, not a copy')
assert(!(await page.isVisible('.chip.chip-deleted')), 'so the link to it isn’t broken')
// u and u again: away, and back.
await keys('u')
await sleep(400)
assert(same(await text(), ['above see [third]', 'Rent']), 'u after p: ' + JSON.stringify(await text()))
await keys('u')
await sleep(500)
assert(same(await text(), ['above see [third]', 'Rent', 'third']), 'u again redoes: ' + JSON.stringify(await text()))

// >> and u; x and u; typing and u.
await page.tap(`.row[data-id="${thirdId}"] .row-text`)
await sleep(200)
await keys('Escape', '>', '>')
await sleep(400)
assert(same(await text(), ['above see [third]', 'Rent', '  third']), '>>: ' + JSON.stringify(await text()))
await keys('u')
await sleep(500)
assert(same(await text(), ['above see [third]', 'Rent', 'third']), 'u puts it back: ' + JSON.stringify(await text()))
await keys('k', '0', 'x')
assert((await activeRowText(page)) === 'ent', 'x')
await keys('u')
assert((await activeRowText(page)) === 'Rent', 'u after x: ' + (await activeRowText(page)))
await keys('A')
await page.keyboard.type('al')
await keys('Escape', 'u')
assert((await activeRowText(page)) === 'Rent', 'u after typing: ' + (await activeRowText(page)))

// gx: on a chip, open what it links to; elsewhere, the line.
// (The picker leaves a space after the chip: b steps back onto it.)
await keys('k', '$', 'b')
assert(await page.isVisible('.chip.vim-cursor'), 'the cursor is on the chip')
await shot(page, 'vim-chip')
await keys('g', 'x')
await page.waitForFunction((id) => location.hash.includes(id), thirdId)
await page.goBack()
await page.waitForSelector('.outline .row')
await sleep(400)
const rentId = (await rowIds())[1]
await page.tap('.row:has-text("Rent") .row-text')
await sleep(200)
await keys('Escape', '0', 'l')
const was = await block()
await keys('g', 'x')
await page.waitForFunction((id) => location.hash.includes(id), rentId)
await sleep(500)
const onTitle = () => page.evaluate(() => document.activeElement?.classList.contains('title'))
assert(await onTitle(), 'gx lands on the page’s title')
assert(await page.evaluate(() => document.querySelector('.editable.title')?.classList.contains('vim-normal')), 'in normal mode')

// Ctrl-O goes back to the line gx was pressed on; Ctrl-I forward again.
await keys('Control+o')
await page.waitForFunction((id) => !location.hash.includes(id), rentId)
await sleep(600)
assert((await activeRowText(page)) === 'Rent', 'Ctrl-O: back on the line: ' + (await activeRowText(page)))
assert(was === 'e' && (await block()) === was, 'with the cursor where it was: ' + (await block()))
await keys('Control+i')
await page.waitForFunction((id) => location.hash.includes(id), rentId)
await sleep(600)
assert(await onTitle(), 'Ctrl-I: forward to the page again')

console.log('console errors:', errors.length ? errors : 'none')
await close()
if (errors.length) process.exit(1)
