// Add a "Relations playground" pad to a sync server, as if typed on another
// device: errands and people written in different ways, so the link labels
// (local guesses, then the server's model) have something to work on. Places
// and people live inside the pad, so deleting the pad removes all of it.
// Usage: node scripts/example-pad.mjs [https://server]   (default: the Pi)

import { randomUUID } from 'node:crypto'
import { generateNKeysBetween } from 'fractional-indexing'

const BASE = (process.argv[2] ?? 'https://utility-server-pi.pirate-emperor.ts.net').replace(/\/$/, '')
const DEVICE = 'example-pad'
const TITLE = 'Relations playground'

async function post(body) {
  const res = await fetch(BASE + '/api/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return res.json()
}

// Everything the server has: to put the pad after the existing ones, and not add it twice.
const fields = new Map()
let since = 0
for (;;) {
  // A different device id for reading: the server leaves out a device’s own changes.
  const r = await post({ device: DEVICE + '-reader', since, changes: [], limit: 5000 })
  for (const c of r.changes) fields.set(`${c.n} ${c.f}`, c.v)
  since = r.cursor
  if (!r.more) break
}
const nodes = new Set([...fields.keys()].map((k) => k.split(' ')[0]))
const live = (id) => fields.get(`${id} deleted_at`) == null && !fields.get(`${id} purged`)
if ([...nodes].some((id) => fields.get(`${id} text`) === TITLE && fields.get(`${id} kind`) === 'pad' && live(id))) {
  console.log(`“${TITLE}” is already there.`)
  process.exit(0)
}
const rootKeys = [...nodes]
  .filter((id) => fields.get(`${id} kind`) === 'pad' && live(id))
  .map((id) => fields.get(`${id} pos`)?.k)
  .filter((k) => typeof k === 'string')
  .sort()
const padKey = generateNKeysBetween(rootKeys.at(-1) ?? null, null, 1)[0]

// ------------------------------------------------------------ content

const ids = {}
const id = (name) => (ids[name] ??= randomUUID())
const t = (name) => `[[${id(name)}]]`
const todo = { task: 1 }
const done = { task: 1, done: 1 }

const pad = id('pad')
const tree = [
  ['Links get labelled by what the words around them say. Open a place or person at the bottom and try the chips at the top of its page.'],
  [
    'Saturday errands',
    { numbered: 1 },
    [
      [`Return the wrong hose clamp to ${t('Garden center')}`, todo],
      [`Pick up potting soil at ${t('Garden center')}`, todo],
      [`Grab twine at ${t('Garden center')} too`, todo],
      [`Drop off the library books at ${t('Library')}`, todo],
      [`Mail Mom’s package at ${t('Post office')}`, todo],
    ],
  ],
  [
    'People',
    {},
    [
      [`Ask ${t('Maya')} about borrowing her ladder`, todo],
      [`Waiting on ${t('Dev')} for the tile quote`, todo],
      [`${t('Maya')} owes me $20 for the concert tickets`, todo],
      [`Borrow ${t('Dev')}’s pressure washer`, todo],
      [`Lunch with ${t('Maya')} and ${t('Dev')} on Friday`],
      [`Remind ${t('Dev')} to bring the extension cord`, todo],
      [`Call ${t('Maya')} back about Saturday`, done],
    ],
  ],
  [
    'Garden',
    {},
    [
      [`Buy tomato cages at ${t('Garden center')}`, todo],
      [`Get mulch from ${t('Garden center')}`, todo],
      [`${t('Garden center')} closes early on Sundays`],
      [`Read up on composting at ${t('Library')}`, todo],
      [`${t('Dev')} said the back bed gets full sun`],
    ],
  ],
  [
    'Places and people in this example',
    {},
    [
      ['Garden center', { id: 'Garden center', kind: 'place' }, [['On Route 9, past the bridge']]],
      ['Library', { id: 'Library', kind: 'place' }],
      ['Post office', { id: 'Post office', kind: 'place' }],
      ['Maya', { id: 'Maya', kind: 'person' }, [['Has a tall ladder']]],
      ['Dev', { id: 'Dev', kind: 'person' }],
    ],
  ],
]

// ------------------------------------------------------------ as sync fields

let wall = Date.now()
let count = 0
const hlc = () => `${wall.toString(36).padStart(9, '0')}-${(count++).toString(36).padStart(4, '0')}-${DEVICE}`
const changes = []
function node(nid, o, pos) {
  const v = {
    kind: o.kind ?? 'item',
    text: o.text ?? '',
    done: o.done ?? 0,
    collapsed: 0,
    deleted_at: null,
    numbered: o.numbered ?? 0,
    task: o.task ?? 0,
    purged: 0,
    created_at: wall,
    pos,
  }
  for (const [f, val] of Object.entries(v)) changes.push({ n: nid, f, v: val, h: hlc() })
}
function add(parent, specs) {
  const keys = generateNKeysBetween(null, null, specs.length)
  specs.forEach(([text, o = {}, kids], i) => {
    const nid = o.id ? id(o.id) : randomUUID()
    node(nid, { ...o, text }, { p: parent, k: keys[i] })
    if (kids) add(nid, kids)
  })
}
node(pad, { kind: 'pad', text: TITLE }, { p: null, k: padKey })
add(pad, tree)

const r = await post({ device: DEVICE, since, changes })
console.log(`Added “${TITLE}” (${changes.length} fields, ${r.accepted} accepted) to ${BASE}`)
