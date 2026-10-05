// Facts: say what something is to something else ("Alex is cofounder of
// Acme") from its page, or make a note you wrote into one. Notes that
// aren't made into facts stay notes.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, watchConsole, shot, outline, assert, BASE, sleep } from './lib.mjs'

const { ctx, close } = await launch({ userDataDir: mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'gs-facts-')) })
const page = ctx.pages()[0] ?? (await ctx.newPage())
const errors = watchConsole(page)
const facts = () => page.$$eval('.fact', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()))
const sheet = (text) => page.tap(`.sheet-action:has-text("${text}")`)

await page.goto(BASE + '/')
await page.waitForSelector('.outline .row')

// A kind for projects, and Alex in People.
await page.tap('.nav-tab:has-text("Contexts")')
await page.waitForSelector('.contexts-page')
await page.tap('text=New kind')
await page.waitForSelector('.dialog-input')
await page.fill('.dialog-input', 'Projects')
await page.tap('.dialog .btn-primary')
await page.waitForSelector('.category-page')
await page.goto(BASE + '/#/people')
await page.waitForSelector('.category-page')
await page.fill('.add-input', 'Alex')
await page.tap('.add-form .btn-primary')
await page.waitForSelector('.title-block')
await sleep(300)
assert(await page.isVisible('.facts-section'), 'a person’s page has room for facts')

// Add a fact: a new relation, and a new project made on the way.
await page.tap('.facts-section .add-row')
await page.waitForSelector('.picker')
await page.keyboard.type('cofounder of')
await sleep(300)
await page.tap('text=New relation “cofounder of”')
await page.waitForSelector('.picker-title:has-text("Alex is cofounder of")')
await page.keyboard.type('Acme')
await sleep(300)
await page.tap('text=New in Projects: “Acme”')
await sleep(700)
assert(JSON.stringify(await facts()) === JSON.stringify(['cofounder of Acme']), 'Alex’s facts: ' + JSON.stringify(await facts()))
await shot(page, 'facts-alex')

// Acme's page shows it, labelled; the label leads back to Alex.
await page.tap('.fact a')
await page.waitForSelector('.backlinks')
await sleep(400)
const linked = await page.innerText('.backlinks')
assert(linked.includes('Alex') && linked.includes('cofounder of'), 'Acme shows Alex, cofounder of: ' + linked)
await shot(page, 'facts-acme')

// A note under Acme, made into a fact about it. Its words start as the relation.
await page.tap('.add-row:has-text("note")')
await sleep(300)
await page.keyboard.type('started at @')
await page.waitForSelector('.picker')
await page.keyboard.type('Garage')
await sleep(300)
await page.tap('text=New in Places: “Garage”')
await sleep(300)
await page.keyboard.type(' in 2023')
await sleep(300)
await page.tap('[aria-label="More actions"]')
await sheet('Make it a fact about “Acme”')
await page.waitForSelector('.picker')
assert((await page.inputValue('.picker-input')) === 'started at in 2023', 'the note’s words start the relation: ' + (await page.inputValue('.picker-input')))
await page.keyboard.type('started at')
await sleep(300)
await page.tap('text=New relation “started at”')
await sleep(700)
assert(JSON.stringify(await facts()) === JSON.stringify(['started at Garage']), 'Acme’s facts: ' + JSON.stringify(await facts()))
assert(!(await outline(page)).some((t) => t.includes('Garage')), 'the note became the fact: ' + JSON.stringify(await outline(page)))

// And back again.
await page.tap('[aria-label="Options for started at Garage"]')
await sheet('Turn it back into a note')
await sleep(700)
assert(!(await page.isVisible('.fact')), 'no facts left')
const notes = (await outline(page)).map((t) => t.replace(/\s+/g, ' ').trim())
assert(notes.includes('started at [Garage]'), 'it’s a note again: ' + JSON.stringify(notes))

// Alex's page still has the fact; change the relation from there.
await page.tap('.backlink:has-text("Alex") .rel')
await page.waitForSelector('.fact')
await page.tap('[aria-label="Options for cofounder of Acme"]')
await sheet('Change the relation…')
await page.waitForSelector('.picker')
await page.keyboard.type('founded')
await sleep(300)
await page.tap('text=New relation “founded”')
await sleep(700)
assert(JSON.stringify(await facts()) === JSON.stringify(['founded Acme']), 'relation changed: ' + JSON.stringify(await facts()))

console.log('console errors:', errors.length ? errors : 'none')
await close()
if (errors.length) process.exit(1)
