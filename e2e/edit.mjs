// Editing flows on a phone-sized touch viewport.
import { launch, watchConsole, shot, outline, activeRowText, assert, BASE, sleep } from './lib.mjs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'gs-e2e-'))
let { ctx, close } = await launch({ userDataDir: dir })
let page = ctx.pages()[0] ?? (await ctx.newPage())
let errors = watchConsole(page)

await page.goto(BASE + '/#/pads')
await page.waitForSelector('.page-title')
// New pad from the pads screen.
await page.tap('text=New pad')
await page.waitForSelector('.editable.title')
await sleep(300)
assert(await page.evaluate(() => document.activeElement?.classList.contains('title')), 'new pad focuses its title')
await page.keyboard.type('Sprinkler project')
await page.keyboard.press('Enter')
await sleep(150)
assert((await outline(page)).length === 1, 'Enter in title creates first item')
assert((await activeRowText(page)) === '', 'focus moved to the new empty item')

await page.keyboard.type('Buy parts')
await page.keyboard.press('Enter')
await page.keyboard.type('elbows')
await page.keyboard.press('Tab')
await page.keyboard.press('Enter')
await page.keyboard.type('tees')
await page.keyboard.press('Enter')
await page.keyboard.type('glue')
await sleep(200)
assert(JSON.stringify(await outline(page)) === JSON.stringify(['Buy parts', '  elbows', '  tees', '  glue']), 'typing + Enter + Tab builds nesting: ' + JSON.stringify(await outline(page)))

// Toolbar via touch taps, focus must stay in the editor.
assert(await page.isVisible('.edit-toolbar'), 'keyboard toolbar visible while editing')
assert(!(await page.isVisible('.bottom-nav')), 'bottom nav hidden while editing')
await page.tap('[aria-label="Move up"]')
await sleep(150)
assert((await activeRowText(page)) === 'glue', 'focus kept after toolbar tap (move up)')
assert(JSON.stringify(await outline(page)) === JSON.stringify(['Buy parts', '  elbows', '  glue', '  tees']), 'move up reorders')
await page.tap('[aria-label="Outdent"]')
await sleep(150)
assert((await activeRowText(page)) === 'glue', 'focus kept after outdent')
assert(JSON.stringify(await outline(page)) === JSON.stringify(['Buy parts', '  elbows', '  tees', 'glue']), 'outdent moves after parent: ' + JSON.stringify(await outline(page)))
await page.tap('[aria-label="Indent"]')
await sleep(150)
assert(JSON.stringify(await outline(page)) === JSON.stringify(['Buy parts', '  elbows', '  tees', '  glue']), 'indent via toolbar')
assert(await page.isDisabled('[aria-label="Move down"]'), 'move down disabled on the last sibling')

// Split in the middle with Enter.
await page.keyboard.press('Enter')
await page.keyboard.type('primer and cement')
for (let i = 0; i < 'and cement'.length; i++) await page.keyboard.press('ArrowLeft')
await page.keyboard.press('Enter')
await sleep(150)
assert(JSON.stringify((await outline(page)).slice(-2)) === JSON.stringify(['  primer ', '  and cement']), 'Enter mid-line splits: ' + JSON.stringify(await outline(page)))
assert((await activeRowText(page)) === 'and cement', 'focus on second half')
// Backspace at start merges back.
await page.keyboard.press('Home')
await page.keyboard.press('Backspace')
await sleep(250)
assert((await outline(page)).at(-1) === '  primer and cement', 'Backspace at start merges: ' + JSON.stringify(await outline(page)))
assert((await activeRowText(page)) === 'primer and cement', 'focus on merged row')

// Empty-line behaviours: Enter on empty last nested outdents; Backspace on empty deletes.
await page.keyboard.press('End')
await page.keyboard.press('Enter')
await page.keyboard.press('Enter')
await sleep(150)
assert((await outline(page)).at(-1) === '', 'Enter on empty nested last item outdents it: ' + JSON.stringify(await outline(page)))
await page.keyboard.press('Backspace')
await sleep(250)
assert((await outline(page)).length === 5, 'Backspace on empty item deletes it')
assert((await activeRowText(page)) === 'primer and cement', 'focus moves to previous row')

// Checkbox via tap.
await page.tap('.row:nth-child(2) .check')
await sleep(200)
assert((await outline(page))[1].endsWith('✓'), 'tapping checkbox marks done')
await shot(page, 'edit-outline')

// Close keyboard, wait for saves, reload, data persists (OPFS).
await page.tap('[aria-label="Hide keyboard"]')
await sleep(900)
const before = await outline(page)
await page.reload()
await page.waitForSelector('.outline .row')
await sleep(300)
assert(JSON.stringify(await outline(page)) === JSON.stringify(before), 'outline survives reload')
assert((await page.textContent('.editable.title')).includes('Sprinkler project'), 'title survives reload')

// Restart the whole browser: still there.
const url = page.url()
await close()
;({ ctx, close } = await launch({ userDataDir: dir }))
page = ctx.pages()[0] ?? (await ctx.newPage())
errors.push(...watchConsole(page))
await page.goto(url)
await page.waitForSelector('.outline .row')
await sleep(300)
assert(JSON.stringify(await outline(page)) === JSON.stringify(before), 'outline survives browser restart')

console.log('console errors:', errors.length ? errors : 'none')
await close()
