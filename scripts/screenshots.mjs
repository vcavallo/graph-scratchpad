// Builds an example database that shows off every feature, imports it into a
// fresh browser profile, and saves the README screenshots to docs/screenshots.
// Usage: npm run screenshots   (set BASE_URL to use an already-running server)
import { execSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateNKeysBetween } from 'fractional-indexing'
import { launch, sleep } from '../e2e/lib.mjs'

const OUT = new URL('../docs/screenshots/', import.meta.url).pathname
mkdirSync(OUT, { recursive: true })

// ------------------------------------------------------------ example data

const nodes = []
const edges = []
let clock = Date.parse('2026-10-03T09:00:00Z')
const tok = (id) => `[[${id}]]`

function node(kind, text, o = {}) {
  const id = o.id ?? randomUUID()
  nodes.push({
    id,
    kind,
    text,
    done: o.done ? 1 : 0,
    collapsed: 0,
    created_at: ++clock,
    updated_at: clock,
    deleted_at: null,
    sort_key: null,
    numbered: o.numbered ? 1 : 0,
    task: kind === 'item' && o.task ? 1 : 0,
    purged: 0,
    category: o.category ?? null,
    props: o.props ? JSON.stringify(o.props) : null,
  })
  return id
}

/** Children from a spec: [text, opts, [children]] or [text, opts]. */
function tree(parent, specs) {
  const keys = generateNKeysBetween(null, null, specs.length)
  specs.forEach(([text, o = {}, kids], i) => {
    const id = node('item', text, o)
    edges.push({ id: randomUUID(), src: parent, dst: id, type: 'child', sort_key: keys[i], created_at: ++clock })
    if (kids) tree(id, kids)
  })
}

const hardware = node('place', 'Hardware store')
const post = node('place', 'Post office')
const sam = node('person', 'Sam')
// A kind of context of your own, with a tab in the bar.
const rooms = node('category', 'Rooms', { props: { icon: 'home', pinned: true, tone: 2 } })
const garage = node('item', 'Garage', { category: rooms })
node('item', 'Kitchen', { category: rooms })
// A relation you kept, with another way you write it folded in.
const buyAt = node('relation', 'buy at')
const groceryId = randomUUID()
const todo = { task: true }
const done = { task: true, done: true }

const saturday = node('pad', 'Saturday')
const garden = node('pad', 'Garden')
const states = node('pad', 'States')
const waiting = randomUUID()
const someday = randomUUID()

tree(saturday, [
  [
    'Order of operations',
    { numbered: true },
    [
      [`Drop off returns at ${tok(post)}`, done],
      [`Pick up sprinkler parts at ${tok(hardware)}`, todo],
      [`Get everything on the ${tok(groceryId)}`, todo],
      [`Borrow ${tok(sam)}’s ladder ${tok(waiting)}`, todo],
    ],
  ],
  [
    'Grocery list',
    { id: groceryId },
    [
      ['milk', done],
      ['eggs', todo],
      ['good bread', todo],
      ['Check the freezer before buying more', {}],
    ],
  ],
  [`Clear the workbench in the ${tok(garage)}`, todo],
  ['Rain after 3pm, so garden things first', {}],
])
tree(garden, [
  [
    'Fix the sprinkler',
    todo,
    [
      [`Buy 3/4-inch PVC elbows at ${tok(hardware)}`, todo],
      [`Grab teflon tape at ${tok(hardware)}`, todo],
      [`Return the wrong hose clamp to ${tok(hardware)}`, todo],
      [`Which zone leaks? Asked ${tok(sam)} ${tok(waiting)}`, todo],
    ],
  ],
  ['Plant the tomatoes', todo],
  [`Build a raised bed ${tok(someday)}`, todo],
  ['Zone 3 is the one by the fence', {}],
])
tree(states, [
  ['waiting', { id: waiting }],
  ['someday', { id: someday }],
])
tree(hardware, [['Closes at 6 on Sundays', {}]])
tree(sam, [['Lives two doors down', {}]])
tree(buyAt, [['pick up at', {}]])

const padKeys = generateNKeysBetween(null, null, 3)
for (const [i, id] of [saturday, garden, states].entries()) nodes.find((n) => n.id === id).sort_key = padKeys[i]
// Link edges match the [[uuid]] tokens in each node's text, as the store keeps them.
for (const n of nodes) {
  for (const [, dst] of n.text.matchAll(/\[\[([0-9a-f-]{36})\]\]/g)) {
    edges.push({ id: randomUUID(), src: n.id, dst, type: 'link', sort_key: null, created_at: ++clock })
  }
}
const file = join(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'gs-demo-')), 'example.json')
writeFileSync(
  file,
  JSON.stringify({ app: 'graph-scratchpad', format: 1, schema_version: 9, exported_at: clock, nodes, edges }, null, 2),
)

// ------------------------------------------------------------ screenshots

let server
if (!process.env.BASE_URL) {
  execSync('npx vite build', { stdio: 'inherit' })
  server = spawn('npx', ['vite', 'preview', '--port', '4176', '--strictPort'], { stdio: 'ignore' })
  process.env.BASE_URL = 'http://localhost:4176'
  await sleep(1500)
}
const BASE = process.env.BASE_URL
const { ctx, close } = await launch({ userDataDir: mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'gs-shots-')) })
const page = ctx.pages()[0] ?? (await ctx.newPage())
const hideToasts = () => page.addStyleTag({ content: '.toasts { display: none !important }' })
// The graph's starting positions are random; seed them so the screenshot is the same every time.
const SEED = Number(process.env.SEED ?? 1)
await page.addInitScript((seed) => {
  let x = seed
  Math.random = () => {
    x = (x * 1664525 + 1013904223) >>> 0
    return x / 2 ** 32
  }
}, SEED)

try {
  await page.goto(BASE + '/')
  await page.waitForSelector('.outline .row')
  await page.goto(BASE + '/#/settings?tab=sync')
  await page.waitForSelector('input[type=file]', { state: 'attached' })
  await page.setInputFiles('input[type=file]', file)
  await page.tap('button:has-text("Replace")')
  await page.waitForSelector('.list-item, .outline .row')
  await sleep(500)

  await page.goto(BASE + '/#/pads')
  await page.tap('.list-item:has-text("Saturday") .list-main')
  await page.waitForSelector('.outline .row')
  await hideToasts()
  await sleep(600)
  await page.screenshot({ path: OUT + 'outline.png' })

  // A place's page: what links there, labelled by relation (yours solid, suggestions outlined).
  await page.goto(`${BASE}/#/n/${hardware}`)
  await page.waitForSelector('.backlinks')
  await hideToasts()
  await sleep(600)
  await page.screenshot({ path: OUT + 'context.png' })

  await page.goto(`${BASE}/#/n/${saturday}`)
  await page.waitForSelector('.outline .row')
  await page.tap('[aria-label="Show graph"]')
  await page.waitForSelector('.gnode')
  await page.tap('.segmented button:has-text("3 steps")')
  await hideToasts()
  await sleep(3500)
  await page.screenshot({ path: OUT + 'graph.png' })
  console.log('Saved outline.png, context.png and graph.png in', OUT)
} finally {
  await close()
  server?.kill()
}
