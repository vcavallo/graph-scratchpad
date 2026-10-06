// Pasting a markdown draft keeps its shape: indentation and headings nest,
// "[ ]" makes to-dos, "- " notes, "1. " numbered lists.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, watchConsole, shot, activeRowText, assert, BASE, sleep } from './lib.mjs'

const { ctx, close } = await launch({ userDataDir: mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'gs-paste-')) })
const page = ctx.pages()[0] ?? (await ctx.newPage())
const errors = watchConsole(page)
const paste = (text) =>
  page.evaluate((t) => {
    const dt = new DataTransfer()
    dt.setData('text/plain', t)
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, text)
// Each row as "  2. [ ] text": depth, number, checkbox.
const rows = () =>
  page.$$eval('.outline .row', (rs) =>
    rs.map((r) => {
      const depth = Number(getComputedStyle(r).getPropertyValue('--depth') || 0)
      const num = r.querySelector('.bullet .num')?.textContent
      const box = r.classList.contains('task') ? (r.classList.contains('done') ? '[x] ' : '[ ] ') : ''
      return '  '.repeat(depth) + (num ? num + ' ' : '') + box + r.querySelector('.row-text').textContent.replace(/​/g, '')
    }),
  )
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

async function newPad(title) {
  await page.goto(BASE + '/#/pads')
  await page.tap('text=New pad')
  await page.waitForSelector('.editable.title')
  await sleep(200)
  if (title) {
    await page.keyboard.type(title)
    await page.keyboard.press('Enter')
    await sleep(150)
  }
}

await page.goto(BASE + '/')
await page.waitForSelector('.outline .row')

// A draft from vim, pasted into the first line of a new pad.
await newPad('Weekend')
await paste(
  [
    '# Garage cleanout',
    '1. Sort the shelves',
    '2. [ ] Haul boxes to the dump',
    '\t- [x] borrow the truck',
    '\t- call the dump first',
    '',
    '# Errands',
    '- [ ] Buy PVC elbows',
    '    - 3/4-inch, not 1/2',
    '- [ ] Return library books',
    'plain line',
  ].join('\n'),
)
await sleep(700)
const want = [
  'Garage cleanout',
  '  1. Sort the shelves',
  '  2. [ ] Haul boxes to the dump',
  '    [x] borrow the truck',
  '    call the dump first',
  'Errands',
  '  [ ] Buy PVC elbows',
  '    3/4-inch, not 1/2',
  '  [ ] Return library books',
  '  [ ] plain line',
]
assert(same(await rows(), want), 'the draft keeps its shape: ' + JSON.stringify(await rows(), null, 1))
assert((await activeRowText(page)) === 'plain line', 'focus on the last pasted line')
await shot(page, 'paste-draft')

// It's stored that way, not just drawn.
await page.reload()
await page.waitForSelector('.outline .row')
await sleep(500)
assert(same(await rows(), want), 'the same after a reload')

// Into a line with text: lines indented under the first go inside it.
await page.tap('.row:has-text("plain line") .row-text')
await page.keyboard.press('End')
await page.keyboard.press('Enter')
await page.keyboard.type('Trip ')
await paste('packing\n  - socks\n  - charger\nafter')
await sleep(700)
const tail = (await rows()).slice(-4)
assert(same(tail, ['  [ ] Trip packing', '    socks', '    charger', '  [ ] after']), 'children go inside the line: ' + JSON.stringify(tail))

// Into the title of a new pad: the first line names it.
await newPad()
await paste('# Saturday\n- [ ] mow\n  - edge too\n- rest')
await sleep(700)
const title = (await page.innerText('.editable.title')).replace(/\u200b/g, '').trim()
assert(title === 'Saturday', 'the first line is the title: ' + title)
assert(same(await rows(), ['[ ] mow', '  edge too', 'rest']), 'the rest is its list: ' + JSON.stringify(await rows()))

console.log('console errors:', errors.length ? errors : 'none')
await close()
if (errors.length) process.exit(1)
