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

console.log('console errors:', errors.length ? errors : 'none')
await close()
if (errors.length) process.exit(1)
