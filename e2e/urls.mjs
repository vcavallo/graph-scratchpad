// Web addresses in bullets are links: underlined, a tap opens one in a line
// you're not editing, a tap while editing puts the caret there to fix it, and
// read-only text (what links to a page) links them too.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, watchConsole, shot, assert, BASE, sleep } from './lib.mjs'

const { ctx, close } = await launch({ userDataDir: mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'gs-urls-')) })
const page = ctx.pages()[0] ?? (await ctx.newPage())
const errors = watchConsole(page)
// Links open new tabs: answer them here instead of going out to the web.
await ctx.route(/example\.(com|org)/, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: 'ok' }))
const opened = []
ctx.on('page', (p) => opened.push(p))
const openedSoon = async (n) => {
  for (let i = 0; i < 20 && opened.length < n; i++) await sleep(100)
  return opened.length >= n ? opened[n - 1] : null
}

/** Where some text is on screen, inside the row's editor. */
const spot = (rowText, text) =>
  page.evaluate(
    ([rowText, text]) => {
      const row = [...document.querySelectorAll('.outline .row')].find((r) => r.textContent.includes(rowText))
      const walker = document.createTreeWalker(row.querySelector('.editable'), NodeFilter.SHOW_TEXT)
      for (let t = walker.nextNode(); t; t = walker.nextNode()) {
        const i = t.data.indexOf(text)
        if (i < 0) continue
        const r = document.createRange()
        r.setStart(t, i)
        r.setEnd(t, i + text.length)
        const b = r.getBoundingClientRect()
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 }
      }
      return null
    },
    [rowText, text],
  )
const editing = () => page.evaluate(() => document.activeElement?.classList.contains('editable') ?? false)

await page.goto(BASE + '/')
await page.waitForSelector('.outline .row')

// A new pad with addresses in its first line.
await page.goto(BASE + '/#/pads')
await page.tap('text=New pad')
await page.waitForSelector('.editable.title')
await sleep(200)
await page.keyboard.type('Reading')
await page.keyboard.press('Enter')
await sleep(150)
await page.keyboard.type('Read https://example.com/docs, then www.example.org.')
await page.tap('[aria-label="Hide keyboard"]')
await sleep(400)
const marked = await page.evaluate(() => (typeof CSS !== 'undefined' && CSS.highlights?.get('gp-url')?.size) || 0)
assert(marked >= 2, 'the addresses are underlined: ' + marked)
await shot(page, 'urls-line')

// Not editing: a tap on an address opens it, and doesn't start editing.
let at = await spot('Read https', 'example.com/docs')
await page.touchscreen.tap(at.x, at.y)
const tab = await openedSoon(1)
assert(tab && tab.url() === 'https://example.com/docs', 'a tap opens the address: ' + tab?.url())
assert(!(await editing()), 'without starting to edit the line')
await tab.close()

// A tap on the rest of the line edits it; then a tap on the address puts the caret in it.
at = await spot('Read https', 'Read')
await page.touchscreen.tap(at.x, at.y)
await sleep(300)
assert(await editing(), 'a tap on the words edits the line')
at = await spot('Read https', 'www.example.org')
await page.touchscreen.tap(at.x, at.y)
await sleep(500)
assert(opened.length === 1, 'while editing, a tap on an address doesn’t open it')
assert(await editing(), 'and the line is still being edited')
await page.tap('[aria-label="Hide keyboard"]')
await sleep(300)

// Read-only text links them too: what links to the Hardware store, shown on its page.
await page.goto(BASE + '/#/pads')
await page.tap('.list-item:has-text("Welcome") .list-main')
await page.waitForSelector('.outline .row')
at = await spot('PVC elbows', 'Buy 3/4-inch PVC elbows')
await page.touchscreen.tap(at.x, at.y)
await sleep(200)
await page.keyboard.press('End')
await page.keyboard.type(' (specs at example.com/elbows)')
await page.tap('[aria-label="Hide keyboard"]')
await sleep(800)
await page.tap('.row:has-text("PVC elbows") .chip:has-text("Hardware store")')
await page.waitForSelector('.backlinks')
const link = await page.getAttribute('.backlinks a.url', 'href')
assert(link === 'https://example.com/elbows', 'a page’s list of what links to it links the address: ' + link)
await page.tap('.backlinks a.url')
const second = await openedSoon(2)
assert(second && second.url() === 'https://example.com/elbows', 'and a tap opens it: ' + second?.url())
assert(page.url().includes('/n/'), 'without leaving the page')
await shot(page, 'urls-backlinks')

console.log('console errors:', errors.length ? errors : 'none')
await close()
if (errors.length) process.exit(1)
