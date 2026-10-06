// Sync between devices through the real server core (on Node's SQLite).
import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { SyncServer } from '../server/sync-server.mjs'
import { syncOnce, type Transport } from '../src/db/sync'
import type { Store } from '../src/db/store'
import { makeToken } from '../src/lib/tokens'
import { makeDb, makeStore, shape } from './helpers'
import { PEOPLE_ID } from '../src/db/types'
import { MIGRATIONS } from '../src/db/migrations'

const BASE = 1_700_000_000_000

function makeServer() {
  return new SyncServer(new DatabaseSync(':memory:'))
}

/** Requests and responses go through JSON, as over the wire. */
function link(server: SyncServer, limit?: number): Transport {
  return async (req) => JSON.parse(JSON.stringify(server.sync({ ...JSON.parse(JSON.stringify(req)), limit })))
}

async function device(server: SyncServer, start = BASE, opts: { batch?: number; limit?: number } = {}) {
  const s = await makeStore({ start })
  let to = server
  return {
    s,
    sync: () => syncOnce(s, link(to, opts.limit), opts.batch),
    useServer: (next: SyncServer) => (to = next),
  }
}

/** Everything that should be the same on every device once synced. */
function dump(s: Store) {
  return {
    nodes: s.db.all(
      'SELECT id, kind, text, done, collapsed, deleted_at, numbered, task, purged, created_at FROM nodes ORDER BY id',
    ),
    parents: s.db.all(`SELECT dst, src, sort_key FROM edges WHERE type = 'child' ORDER BY dst`),
    roots: s.db.all('SELECT id, sort_key FROM nodes WHERE sort_key IS NOT NULL ORDER BY id'),
    links: s.db.all(`SELECT src, dst FROM edges WHERE type = 'link' ORDER BY src, dst`),
  }
}

/** Sync every device, a few times round, so repairs made while merging travel too. */
async function settle(...devices: { sync: () => Promise<unknown>; s: Store }[]) {
  for (let round = 0; round < 6; round++) {
    for (const d of devices) await d.sync()
    if (devices.every((d) => d.s.syncInfo().pending === 0)) break
  }
  for (const d of devices) await d.sync()
}

describe('sync', () => {
  it('copies one device’s lists to another', async () => {
    const server = makeServer()
    const a = await device(server)
    const b = await device(server)
    const pad = a.s.createPad('Groceries')
    const place = a.s.createNode('place', 'Shop')
    const milk = a.s.createChild(pad, undefined, { text: `milk at ${makeToken(place)}` })
    a.s.createChild(milk, undefined, { text: 'oat', task: false })
    a.s.setNumbered(pad, true)
    await a.sync()
    await b.sync()
    expect(dump(b.s)).toEqual(dump(a.s))
    expect(shape(b.s, pad)).toEqual([`milk at ${makeToken(place)}`, ['oat']])
    expect(b.s.getBacklinks(place).map((x) => x.source.id)).toEqual([milk])
    expect(a.s.syncInfo().pending).toBe(0)
  })

  it('merges edits to different fields of the same line', async () => {
    const server = makeServer()
    const a = await device(server)
    const b = await device(server)
    const pad = a.s.createPad('P')
    const x = a.s.createChild(pad, undefined, { text: 'x' })
    await settle(a, b)
    a.s.updateText(x, 'x from a')
    b.s.setDone(x, true)
    b.s.setCollapsed(x, true)
    await settle(a, b)
    for (const d of [a, b]) expect(d.s.getNode(x)).toMatchObject({ text: 'x from a', done: true, collapsed: true })
  })

  it('keeps the newer edit when both change the same field, whoever syncs first', async () => {
    const server = makeServer()
    const a = await device(server, BASE)
    const b = await device(server, BASE + 60_000) // b's edits are a minute later
    const pad = a.s.createPad('P')
    const x = a.s.createChild(pad, undefined, { text: 'x' })
    await settle(a, b)
    b.s.updateText(x, 'later')
    a.s.updateText(x, 'earlier')
    await b.sync()
    await a.sync() // a's older edit loses on the server…
    await b.sync()
    for (const d of [a, b]) expect(d.s.getNode(x)!.text).toBe('later') // …and a takes b's
  })

  it('orders an edit made after seeing a change after it, even with a slow clock', async () => {
    const server = makeServer()
    const fast = await device(server, BASE + 3_600_000)
    const slow = await device(server, BASE) // an hour behind
    const pad = fast.s.createPad('P')
    const x = fast.s.createChild(pad, undefined, { text: 'from the fast clock' })
    await settle(fast, slow)
    slow.s.updateText(x, 'edited after seeing it')
    await settle(slow, fast)
    expect(fast.s.getNode(x)!.text).toBe('edited after seeing it')
  })

  it('carries moves, deletes and restores', async () => {
    const server = makeServer()
    const a = await device(server)
    const b = await device(server)
    const pad = a.s.createPad('P')
    const [p, q, r] = ['p', 'q', 'r'].map((t) => a.s.createChild(pad, undefined, { text: t }))
    await settle(a, b)
    a.s.indent(q)
    a.s.moveUp(r)
    b.s.deleteSubtree(p)
    await settle(a, b)
    expect(shape(a.s, pad)).toEqual(['r'])
    expect(dump(a.s)).toEqual(dump(b.s))
    a.s.restoreSubtree(p)
    await settle(a, b)
    expect(shape(b.s, pad)).toEqual(shape(a.s, pad))
    expect(shape(b.s, pad)).toEqual(['r', 'p', ['q']])
  })

  it('rebuilds links on arrival, even when the linked node comes in a later batch', async () => {
    const server = makeServer()
    const a = await device(server, BASE, { batch: 3 })
    const b = await device(server, BASE, { limit: 3 })
    const pad = a.s.createPad('P')
    const items = Array.from({ length: 5 }, (_, i) => a.s.createChild(pad, undefined, { text: `i${i}` }))
    const place = a.s.createNode('place', 'Shop') // created last: synced after the lines that link to it
    for (const id of items) a.s.updateText(id, `go to ${makeToken(place)}`)
    await a.sync()
    await b.sync()
    expect(b.s.getBacklinks(place)).toHaveLength(5)
    expect(dump(b.s)).toEqual(dump(a.s))
  })

  it('empties the trash everywhere', async () => {
    const server = makeServer()
    const a = await device(server)
    const b = await device(server)
    const pad = a.s.createPad('P')
    const x = a.s.createChild(pad, undefined, { text: 'secret' })
    await settle(a, b)
    a.s.deleteSubtree(x)
    a.s.purgeDeleted()
    await settle(a, b)
    expect(b.s.getNode(x)).toBeNull()
    expect(b.s.listDeleted()).toHaveLength(0)
    expect(b.s.search('secret')).toHaveLength(0)
  })

  it('keeps "only to-dos are done" when edits cross', async () => {
    const server = makeServer()
    const a = await device(server, BASE)
    const b = await device(server, BASE + 60_000)
    const pad = a.s.createPad('P')
    const x = a.s.createChild(pad, undefined, { text: 'x', task: true })
    await settle(a, b)
    a.s.setTask(x, false) // a makes it a bullet…
    b.s.setDone(x, true) // …b, later, checks it off
    await settle(a, b)
    for (const d of [a, b]) expect(d.s.getNode(x)).toMatchObject({ task: true, done: true })
  })

  it('breaks a loop made by moving two lines into each other on two devices', async () => {
    const server = makeServer()
    const a = await device(server)
    const b = await device(server)
    const pad = a.s.createPad('P')
    const p = a.s.createChild(pad, undefined, { text: 'p' })
    const q = a.s.createChild(pad, undefined, { text: 'q' })
    await settle(a, b)
    a.s.moveSubtree(p, q)
    b.s.moveSubtree(q, p)
    await settle(a, b)
    expect(dump(a.s)).toEqual(dump(b.s))
    for (const d of [a, b]) {
      for (const id of [p, q]) expect(d.s.getAncestors(id)[0]?.kind).toBe('pad') // both reachable again
    }
  })

  it('does not send the untouched welcome pad, and a joining device drops its own', async () => {
    const server = makeServer()
    const a = await device(server)
    const pad = a.s.createPad('Real')
    a.s.createChild(pad, undefined, { text: 'x' })
    await a.sync()
    // A device that keeps its welcome pad doesn't upload it.
    const c = await device(server)
    expect(c.s.seedIfEmpty()).not.toBeNull()
    await c.sync()
    expect(server.info().nodes).toBe(2)
    // One that joins first drops it and gets just the shared lists.
    const b = await device(server)
    expect(b.s.seedIfEmpty()).not.toBeNull()
    expect(b.s.syncPrepareJoin()).toBe(true)
    await b.sync()
    expect(b.s.listPads().map((x) => x.label)).toEqual(['Real'])
    expect(dump(b.s)).toEqual(dump(a.s))
  })

  it('sends a welcome line once it is edited, with what it needs around it', async () => {
    const server = makeServer()
    const a = await device(server)
    const welcome = a.s.seedIfEmpty()!
    const store = a.s.listByKind('place')[0].id
    const line = a.s.getTree(welcome).children.find((c) => c.text.startsWith('Fix the sprinkler'))!.children[0]
    a.s.updateText(line.id, `${line.text} today`)
    expect(a.s.syncPrepareJoin()).toBe(false) // it's real data now
    await a.sync()
    const b = await device(server)
    await b.sync()
    expect(b.s.getNode(line.id)!.text).toBe(`${line.text} today`)
    expect(b.s.getAncestors(line.id).map((c) => c.label)).toEqual(['Welcome', 'Fix the sprinkler'])
    expect(b.s.getNode(store)?.kind).toBe('place')
    expect(b.s.getBacklinks(store).map((x) => x.source.id)).toEqual([line.id])
  })

  it('uploads everything a device had before sync existed', async () => {
    // A phone's database from before migration 5, with lists in it.
    const db = await makeDb()
    for (const m of MIGRATIONS.filter((m) => m.version <= 4)) db.exec(m.sql)
    db.exec("INSERT INTO meta (key, value) VALUES ('schema_version', '4')")
    const ins = 'INSERT INTO nodes (id, kind, text, done, task, sort_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1)'
    const [pad, x, place] = ['a1111111-1111-4111-8111-111111111111', 'b2222222-2222-4222-8222-222222222222', 'c3333333-3333-4333-8333-333333333333']
    db.exec(ins, [pad, 'pad', 'Old pad', 0, 0, 'a0'])
    db.exec(ins, [x, 'item', `buy at [[${place}]]`, 1, 1, null])
    db.exec(ins, [place, 'place', 'Shop', 0, 0, null])
    db.exec("INSERT INTO edges (id, src, dst, type, sort_key, created_at) VALUES ('e1', ?, ?, 'child', 'a0', 1)", [pad, x])
    db.exec("INSERT INTO edges (id, src, dst, type, sort_key, created_at) VALUES ('e2', ?, ?, 'link', NULL, 1)", [x, place])
    const phone = await makeStore({ db })
    const server = makeServer()
    await syncOnce(phone, link(server))
    const b = await device(server)
    await b.sync()
    expect(shape(b.s, pad)).toEqual([`buy at [[${place}]]`])
    expect(b.s.getNode(x)).toMatchObject({ done: true, task: true })
    expect(b.s.getBacklinks(place).map((l) => l.source.id)).toEqual([x])
    expect(dump(b.s)).toEqual(dump(phone))
  })

  it('carries your relations and the relations you chose for single links', async () => {
    const server = makeServer()
    const a = await device(server)
    const b = await device(server)
    const pad = a.s.createPad('P')
    const shop = a.s.createNode('place', 'Shop')
    const x = a.s.createChild(pad, undefined, { text: `Pick up tape at ${makeToken(shop)}` })
    const y = a.s.createChild(pad, undefined, { text: `Get mulch from ${makeToken(shop)}` })
    await settle(a, b)
    const buy = b.s.keepRelation('pick up at', 'buy at')
    a.s.ignorePhrase('get from')
    await settle(a, b)
    a.s.setLinkRelation(y, shop, buy)
    await settle(a, b)
    for (const d of [a, b]) {
      expect(d.s.getBacklinks(shop).map((l) => [l.source.id, l.phrase, l.pinned]).sort()).toEqual(
        [[x, 'buy at', false], [y, 'buy at', true]].sort(),
      )
    }
    expect(dump(a.s)).toEqual(dump(b.s))
  })

  it('carries kinds of context, what each thing is, and changes to the built-in kinds', async () => {
    const server = makeServer()
    const a = await device(server)
    const b = await device(server)
    const pad = a.s.createPad('P')
    const rooms = a.s.createCategory('Rooms', { icon: 'home', pinned: true })
    const garage = a.s.createChild(pad, undefined, { text: 'Garage' })
    a.s.setCategory(garage, rooms)
    a.s.setCategoryProps(PEOPLE_ID, { pinned: true })
    await settle(a, b)
    expect(b.s.listCategories().map((c) => [c.name, c.pinned])).toEqual([
      ['Places', true],
      ['People', true],
      ['Rooms', true],
    ])
    expect(b.s.listContexts(rooms).map((c) => c.id)).toEqual([garage])
    expect(dump(a.s)).toEqual(dump(b.s))
  })

  it('carries facts, with their links', async () => {
    const server = makeServer()
    const a = await device(server)
    const b = await device(server)
    const alex = a.s.createNode('person', 'Alex')
    const acme = a.s.createNode('item', 'Acme')
    const cofounder = a.s.keepRelation('cofounder of')
    a.s.addFact(alex, cofounder, acme)
    await settle(a, b)
    expect(b.s.getNodeView(alex).facts.map((f) => [f.name, f.target.id])).toEqual([['cofounder of', acme]])
    expect(b.s.getBacklinks(acme)).toMatchObject([{ fact: true, phrase: 'cofounder of' }])
    expect(dump(a.s)).toEqual(dump(b.s))
  })

  it('starts over on a reset device: none of its old lists go to the next server', async () => {
    const first = makeServer()
    const second = makeServer()
    const other = await device(second, BASE + 50_000)
    other.s.createChild(other.s.createPad('Theirs'), undefined, { text: 'their line' })
    await other.sync()
    const d = await device(first)
    d.s.createChild(d.s.createPad('Mine'), undefined, { text: 'my line' })
    await d.sync()
    d.s.resetDevice()
    expect(d.s.listPads()).toEqual([])
    expect(d.s.syncInfo()).toMatchObject({ enabled: null, epoch: null, pending: 0 })
    expect(d.s.getNode(PEOPLE_ID)?.text).toBe('People')
    d.s.syncSetEnabled(true)
    d.useServer(second)
    await d.sync()
    expect(d.s.listPads().map((p) => p.label)).toEqual(['Theirs'])
    const seen = second.sync({ device: 'peek', since: 0, changes: [] }).changes
    expect(seen.some((c) => c.v === 'Mine' || c.v === 'my line')).toBe(false)
    expect(seen.some((c) => c.n === PEOPLE_ID)).toBe(false)
  })

  it('fills a new or reset server from the devices', async () => {
    const server = makeServer()
    const a = await device(server)
    const b = await device(server)
    const pad = a.s.createPad('P')
    a.s.createChild(pad, undefined, { text: 'x' })
    await settle(a, b)
    const fresh = makeServer() // the old server's data is gone
    a.useServer(fresh)
    b.useServer(fresh)
    b.s.createChild(pad, undefined, { text: 'y' })
    await settle(a, b)
    expect(fresh.info().nodes).toBe(3)
    expect(shape(a.s, pad)).toEqual(['x', 'y'])
    expect(dump(a.s)).toEqual(dump(b.s))
  })

  // SYNC_FUZZ=50 npx vitest run tests/sync.test.ts for a longer soak.
  const seeds = Array.from({ length: Number(process.env.SYNC_FUZZ ?? 6) }, (_, i) => i + 1)
  for (const seed of seeds) {
    it(`converges after random edits on three devices (seed ${seed})`, async () => {
      let x = seed
      const rand = () => {
        x = (x * 1664525 + 1013904223) >>> 0
        return x / 2 ** 32
      }
      const pick = <T>(xs: T[]): T | undefined => xs[Math.floor(rand() * xs.length)]
      const server = makeServer()
      const devs = await Promise.all([0, 1, 2].map((i) => device(server, BASE + i * 7_000)))
      const pad = devs[0].s.createPad('P')
      for (let i = 0; i < 4; i++) devs[0].s.createChild(pad, undefined, { text: `n${i}` })
      await settle(...devs)
      for (let step = 0; step < (process.env.SYNC_FUZZ ? 400 : 150); step++) {
        const d = pick(devs)!
        if (rand() < 0.15) {
          await d.sync()
          continue
        }
        const s = d.s
        const live = s.db
          .all<{ id: string }>(`SELECT id FROM nodes WHERE deleted_at IS NULL AND kind = 'item'`)
          .map((r) => r.id)
          .filter((id) => s.getAncestors(id)[0]?.id === pad)
        const id = pick(live)
        try {
          switch (Math.floor(rand() * 11)) {
            case 0:
              s.createChild(id ?? pad, undefined, { text: `c${step}` })
              break
            case 1:
              if (id) s.createSibling(id, rand() < 0.5 ? 'before' : 'after', { text: `s${step}` })
              break
            case 2:
              if (id) s.updateText(id, rand() < 0.3 && live.length ? `t${step} ${makeToken(pick(live)!)}` : `t${step}`)
              break
            case 3:
              if (id) s.setDone(id, rand() < 0.6)
              break
            case 4:
              if (id) s.setTask(id, rand() < 0.5)
              break
            case 5:
              if (id) s.indent(id)
              break
            case 6:
              if (id) s.outdent(id)
              break
            case 7:
              if (id) (rand() < 0.5 ? s.moveUp(id) : s.moveDown(id))
              break
            case 8: {
              const to = pick(live)
              if (id && to) s.moveSubtree(id, to)
              break
            }
            case 9:
              if (id && rand() < 0.5) s.deleteSubtree(id)
              break
            case 10: {
              const gone = pick(s.listDeleted())
              if (gone) s.restoreSubtree(gone.id)
              break
            }
          }
        } catch (e) {
          // Moves into a descendant and the like are refused; that's fine.
          if (!(e instanceof Error && 'code' in e)) throw e
        }
      }
      await settle(...devs)
      const first = dump(devs[0].s)
      for (const d of devs.slice(1)) expect(dump(d.s)).toEqual(first)
      // Nothing is stranded in a loop: every live node reaches a root.
      for (const n of first.nodes as { id: string; deleted_at: number | null }[]) {
        const up = devs[0].s.getAncestors(n.id)
        if (up.length) expect(devs[0].s.getNode(up[0].id)).not.toBeNull()
        expect(up.some((c) => c.id === n.id)).toBe(false)
      }
    })
  }
})
