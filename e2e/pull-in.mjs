// A line that is only a link to a to-do is that to-do: pull items from a
// brain-dump list into "Today", check them off there, and they're done
// everywhere.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, watchConsole, shot, outline, assert, BASE, sleep } from './lib.mjs'

const { ctx, close } = await launch({ userDataDir: mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'gs-pull-')) })
const page = ctx.pages()[0] ?? (await ctx.newPage())
const errors = watchConsole(page)

async function newPad(title) {
  await page.goto(BASE + '/#/pads')
  await page.tap('text=New pad')
  await page.waitForSelector('.editable.title')
  await sleep(200)
  await page.keyboard.type(title)
  await page.keyboard.press('Enter')
  await sleep(150)
}

await page.goto(BASE + '/')
await page.waitForSelector('.outline .row')
await newPad('Dump')
await page.keyboard.type('Buy baking soda')
await page.keyboard.press('Enter')
await page.keyboard.type('Fix the gate')
await page.keyboard.press('Enter')
await page.keyboard.type('Call the vet')
await page.tap('[aria-label="Hide keyboard"]')
await sleep(700)

// Today: a plain bullet that's only a link to the to-do becomes that to-do.
await newPad('Today')
await page.keyboard.type('- ')
await page.keyboard.type('@')
await page.waitForSelector('.picker')
await page.keyboard.type('baking')
await sleep(300)
await page.tap('.picker-item:has-text("Buy baking soda")')
await sleep(300)
await page.tap('[aria-label="Hide keyboard"]')
await sleep(800)
assert(await page.isVisible('.row.ref .check'), 'the line shows the to-do’s checkbox')
await page.tap('.row.ref .check')
await sleep(600)
assert((await outline(page))[0].endsWith('✓'), 'checked off here')
await shot(page, 'pull-in-today')

await page.goto(BASE + '/#/pads')
await page.tap('.list-item:has-text("Dump") .list-main')
await page.waitForSelector('.outline .row')
await sleep(400)
assert((await outline(page)).includes('Buy baking soda ✓'), 'and done where it lives: ' + JSON.stringify(await outline(page)))

// Its page says where it's pulled in, instead of counting another open to-do.
await page.tap('.row:has-text("Buy baking soda") .bullet')
await page.waitForSelector('.title-block')
await sleep(400)
assert((await page.innerText('.also-on')).includes('Today'), 'its page shows it’s also on Today')
assert(!(await page.isVisible('.backlinks .count:has-text("open")')), 'without an extra open to-do')
await shot(page, 'pull-in-item')

// The other way round: from the dump list, Send to… Today.
await page.goto(BASE + '/#/pads')
await page.tap('.list-item:has-text("Dump") .list-main')
await page.waitForSelector('.outline .row')
await page.tap('.row:has-text("Fix the gate") .row-text')
await page.tap('[aria-label="More actions"]')
await page.tap('.sheet-action:has-text("Send to…")')
await page.waitForSelector('.picker')
await page.tap('.picker-item:has-text("Today")')
await page.waitForSelector('.picker-here')
assert((await page.innerText('.picker-here')).includes('Send to “Today”'), 'the picker sends instead of moving')
await page.tap('.picker-here')
await sleep(500)
assert(await page.isVisible('.toast:has-text("Sent to “Today”")'), 'it says where it went')
// Next time, the last list is one tap away.
await page.tap('.row:has-text("Call the vet") .row-text')
await page.tap('[aria-label="More actions"]')
await page.tap('.sheet-action:has-text("Send to “Today”")')
await sleep(500)
await page.tap('[aria-label="Hide keyboard"]').catch(() => {})
await page.goto(BASE + '/#/pads')
await page.tap('.list-item:has-text("Today") .list-main')
await page.waitForSelector('.outline .row')
await sleep(400)
const today = (await outline(page)).map((t) => t.replace(/\s+/g, ' ').trim())
assert(JSON.stringify(today) === JSON.stringify(['[Buy baking soda] ✓', '[Fix the gate]', '[Call the vet]']), 'Today has all three: ' + JSON.stringify(today))
assert((await page.$$('.row.ref .check')).length === 3, 'each with its checkbox')
await shot(page, 'send-to-today')

console.log('console errors:', errors.length ? errors : 'none')
await close()
if (errors.length) process.exit(1)
