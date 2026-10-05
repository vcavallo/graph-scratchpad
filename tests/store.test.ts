import { beforeEach, describe, expect, it } from 'vitest'
import { makeDb, makeStore, shape } from './helpers'
import type { Store } from '../src/db/store'
import { MIGRATIONS, LATEST_SCHEMA_VERSION } from '../src/db/migrations'
import { makeToken } from '../src/lib/tokens'
import { NO_RELATION_ID, PEOPLE_ID, PLACES_ID } from '../src/db/types'

let s: Store
let pad: string

/** Build children under a parent from a nested spec like ['a', ['a1'], 'b']. */
function build(parent: string, spec: unknown[]): Record<string, string> {
  const ids: Record<string, string> = {}
  let last: string | undefined
  for (const item of spec) {
    if (Array.isArray(item)) {
      Object.assign(ids, build(last!, item))
    } else {
      last = s.createChild(parent, undefined, { text: item as string })
      ids[item as string] = last
    }
  }
  return ids
}

function linkEdges(src: string): string[] {
  return s.db
    .all<{ dst: string }>(`SELECT dst FROM edges WHERE src = ? AND type = 'link' ORDER BY dst`, [src])
    .map((r) => r.dst)
}

beforeEach(async () => {
  s = await makeStore()
  pad = s.createPad('Project')
})

describe('schema', () => {
  it('runs every migration and records the version', () => {
    expect(s.info().schemaVersion).toBe(LATEST_SCHEMA_VERSION)
    expect(LATEST_SCHEMA_VERSION).toBe(MIGRATIONS.length)
  })

  it('enforces one parent per node', () => {
    const [a, b] = [s.createChild(pad), s.createChild(pad)]
    expect(() =>
      s.db.exec(`INSERT INTO edges (id, src, dst, type, sort_key, created_at) VALUES ('x', ?, ?, 'child', 'a0', 0)`, [
        a,
        b,
      ]),
    ).toThrow(/UNIQUE/)
  })
})

describe('creating', () => {
  it('appends, prepends, and inserts after a sibling', () => {
    const a = s.createChild(pad, undefined, { text: 'a' })
    s.createChild(pad, undefined, { text: 'c' })
    s.createChild(pad, null, { text: 'first' })
    s.createChild(pad, a, { text: 'b' })
    expect(shape(s, pad)).toEqual(['first', 'a', 'b', 'c'])
  })

  it('creates siblings before and after', () => {
    const { b } = build(pad, ['a', 'b', 'c'])
    s.createSibling(b, 'before', { text: 'before-b' })
    s.createSibling(b, 'after', { text: 'after-b' })
    expect(shape(s, pad)).toEqual(['a', 'before-b', 'b', 'after-b', 'c'])
  })

  it('generates uuid ids', () => {
    const id = s.createChild(pad)
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('refuses to create under a deleted node', () => {
    const a = s.createChild(pad)
    s.deleteSubtree(a)
    expect(() => s.createChild(a)).toThrow(/deleted/)
  })

  it('splits a node, keeping children on the first half', () => {
    const { ab } = build(pad, ['ab', ['kid'], 'z'])
    const n = s.splitNode(ab, 'a', 'b')
    expect(s.getNode(n)?.text).toBe('b')
    expect(shape(s, pad)).toEqual(['a', ['kid'], 'b', 'z'])
  })
})

describe('indent / outdent', () => {
  it('indents under the previous sibling, as its last child', () => {
    const { b } = build(pad, ['a', ['a1'], 'b', 'c'])
    expect(s.indent(b)).toBe(true)
    expect(shape(s, pad)).toEqual(['a', ['a1', 'b'], 'c'])
  })

  it('indenting the first child is a no-op', () => {
    const { a } = build(pad, ['a', 'b'])
    expect(s.indent(a)).toBe(false)
    expect(shape(s, pad)).toEqual(['a', 'b'])
  })

  it('indent skips deleted siblings and expands a collapsed new parent', () => {
    const { a, gone, c } = build(pad, ['a', 'gone', 'c'])
    s.deleteSubtree(gone)
    s.setCollapsed(a, true)
    s.indent(c)
    expect(shape(s, pad)).toEqual(['a', ['c']])
    expect(s.getNode(a)?.collapsed).toBe(false)
  })

  it('outdents to right after the parent', () => {
    const { a1 } = build(pad, ['a', ['a1', 'a2'], 'b'])
    expect(s.outdent(a1)).toBe(true)
    expect(shape(s, pad)).toEqual(['a', ['a2'], 'a1', 'b'])
  })

  it('outdenting a top-level item is a no-op', () => {
    const { a } = build(pad, ['a'])
    expect(s.outdent(a)).toBe(false)
    expect(shape(s, pad)).toEqual(['a'])
  })

  it('indent then outdent round-trips', () => {
    const { b } = build(pad, ['a', 'b', 'c'])
    s.indent(b)
    s.outdent(b)
    expect(shape(s, pad)).toEqual(['a', 'b', 'c'])
  })

  it('moves the whole subtree', () => {
    const { b } = build(pad, ['a', 'b', ['b1', ['b1x']]])
    s.indent(b)
    expect(shape(s, pad)).toEqual(['a', ['b', ['b1', ['b1x']]]])
  })
})

describe('moveUp / moveDown', () => {
  it('swaps with neighbours', () => {
    const { b } = build(pad, ['a', 'b', 'c'])
    expect(s.moveUp(b)).toBe(true)
    expect(shape(s, pad)).toEqual(['b', 'a', 'c'])
    expect(s.moveDown(b)).toBe(true)
    expect(s.moveDown(b)).toBe(true)
    expect(shape(s, pad)).toEqual(['a', 'c', 'b'])
  })

  it('is a no-op at the ends', () => {
    const { a, c } = build(pad, ['a', 'b', 'c'])
    expect(s.moveUp(a)).toBe(false)
    expect(s.moveDown(c)).toBe(false)
    expect(shape(s, pad)).toEqual(['a', 'b', 'c'])
  })

  it('jumps over deleted siblings', () => {
    const { b, c } = build(pad, ['a', 'b', 'x', 'c'])
    s.deleteSubtree(s.getChildren(pad)[2].id)
    s.moveDown(b)
    expect(shape(s, pad)).toEqual(['a', 'c', 'b'])
    s.moveUp(c)
    expect(shape(s, pad)).toEqual(['c', 'a', 'b'])
  })

  it('survives many reorders with fractional keys', () => {
    const ids = build(pad, ['a', 'b', 'c', 'd'])
    for (let i = 0; i < 60; i++) s.moveUp(ids.d), s.moveDown(ids.d), s.moveUp(ids.c)
    expect(shape(s, pad)).toHaveLength(4)
    expect(new Set(shape(s, pad) as string[])).toEqual(new Set(['a', 'b', 'c', 'd']))
  })

  it('re-keys siblings when keys collide', () => {
    const { a, b, c } = build(pad, ['a', 'b', 'c'])
    s.db.exec(`UPDATE edges SET sort_key = 'a0' WHERE type = 'child' AND dst IN (?, ?, ?)`, [a, b, c])
    s.createChild(pad, a, { text: 'after-a' })
    const order = shape(s, pad) as string[]
    expect(order).toHaveLength(4)
    expect(order.indexOf('after-a')).toBe(order.indexOf('a') + 1)
  })
})

describe('moveSubtree', () => {
  it('moves a node to another parent and position', () => {
    const other = s.createPad('Other')
    const { b } = build(pad, ['a', 'b', ['b1']])
    const { x } = build(other, ['x', 'y'])
    expect(s.moveSubtree(b, other, x)).toBe(true)
    expect(shape(s, pad)).toEqual(['a'])
    expect(shape(s, other)).toEqual(['x', 'b', ['b1'], 'y'])
  })

  it('moves to first and last', () => {
    const { a, c } = build(pad, ['a', 'b', 'c'])
    s.moveSubtree(c, pad, null)
    expect(shape(s, pad)).toEqual(['c', 'a', 'b'])
    s.moveSubtree(a, pad)
    expect(shape(s, pad)).toEqual(['c', 'b', 'a'])
  })

  it('rejects moving a node under its own descendant', () => {
    const { a, a2 } = build(pad, ['a', ['a1', ['a2']]])
    expect(() => s.moveSubtree(a, a2)).toThrow(/descendant/)
    expect(() => s.moveSubtree(a, a)).toThrow(/descendant/)
    expect(shape(s, pad)).toEqual(['a', ['a1', ['a2']]])
  })

  it('gives a parentless node a parent', () => {
    const place = s.createNode('place', 'Hardware store')
    s.moveSubtree(place, pad)
    expect(shape(s, pad)).toEqual(['Hardware store'])
  })

  it('refuses to put a pad under something', () => {
    const other = s.createPad('Other')
    expect(() => s.moveSubtree(other, pad)).toThrow(/Pads/)
  })

  it('keeps links intact when nodes move', () => {
    const place = s.createNode('place', 'Hardware store')
    const { buy } = build(pad, ['a', 'buy'])
    s.updateText(buy, `buy elbows at ${makeToken(place)}`)
    s.indent(buy)
    expect(s.getBacklinks(place).map((b) => b.source.id)).toEqual([buy])
  })
})

describe('delete / restore', () => {
  it('soft-deletes a whole subtree', () => {
    const { a } = build(pad, ['a', ['a1', ['a2']], 'b'])
    expect(s.deleteSubtree(a).count).toBe(3)
    expect(shape(s, pad)).toEqual(['b'])
    expect(s.getNode(a)?.deleted).toBe(true)
  })

  it('restores exactly the batch that was deleted', () => {
    const { a, a1, a2 } = build(pad, ['a', ['a1', 'a2']])
    s.deleteSubtree(a2)
    s.deleteSubtree(a)
    s.restoreSubtree(a)
    expect(shape(s, pad)).toEqual(['a', ['a1']])
    expect(s.getNode(a1)?.deleted).toBe(false)
    expect(s.getNode(a2)?.deleted).toBe(true)
  })

  it('restoring a node under a deleted parent restores the parent too', () => {
    const { a, a1 } = build(pad, ['a', ['a1']])
    s.deleteSubtree(a1)
    s.deleteSubtree(a)
    s.restoreSubtree(a1)
    expect(shape(s, pad)).toEqual(['a', ['a1']])
  })

  it('lists trash entries and purges them', () => {
    const { a } = build(pad, ['a', ['a1'], 'b'])
    s.deleteSubtree(a)
    const trash = s.listDeleted()
    expect(trash).toHaveLength(1)
    expect(trash[0]).toMatchObject({ id: a, count: 2, label: 'a' })
    expect(trash[0].crumbs.map((c) => c.label)).toEqual(['Project'])
    s.purgeDeleted()
    expect(s.getNode(a)).toBeNull()
    expect(s.listDeleted()).toHaveLength(0)
    expect(shape(s, pad)).toEqual(['b'])
  })

  it('merges into the previous row', () => {
    const { a, b } = build(pad, ['a', 'b'])
    expect(s.mergeInto(b, a)).toBe(true)
    expect(shape(s, pad)).toEqual(['ab'])
  })

  it('refuses to merge a node with children or backlinks', () => {
    const { a, b, c } = build(pad, ['a', 'b', ['b1'], 'c'])
    expect(s.mergeInto(b, a)).toBe(false)
    s.updateText(a, `see ${makeToken(c)}`)
    expect(s.mergeInto(c, b)).toBe(false)
  })
})

describe('links', () => {
  it('reconciles link edges with tokens on save', () => {
    const p1 = s.createNode('place', 'Hardware store')
    const p2 = s.createNode('person', 'Sam')
    const { buy } = build(pad, ['buy'])
    s.updateText(buy, `buy at ${makeToken(p1)} with ${makeToken(p2)}`)
    expect(linkEdges(buy)).toEqual([p1, p2].sort())
    s.updateText(buy, `buy at ${makeToken(p1)} ${makeToken(p1)}`)
    expect(linkEdges(buy)).toEqual([p1])
    s.updateText(buy, 'nothing')
    expect(linkEdges(buy)).toEqual([])
  })

  it('ignores tokens that point at nothing, and self-links', () => {
    const { a } = build(pad, ['a'])
    s.updateText(a, `${makeToken('00000000-0000-4000-8000-000000000000')} ${makeToken(a)}`)
    expect(linkEdges(a)).toEqual([])
  })

  it('creates link edges for a node created with tokens', () => {
    const p = s.createNode('place', 'Store')
    const n = s.createChild(pad, undefined, { text: `go ${makeToken(p)}` })
    expect(linkEdges(n)).toEqual([p])
  })

  it('renders labels with nested tokens and survives cycles', () => {
    const a = s.createNode('place', 'A')
    const b = s.createNode('place', `B near ${makeToken(a)}`)
    s.updateText(a, `A near ${makeToken(b)}`)
    const refs = s.getRefs([a, b])
    expect(refs[b].label).toMatch(/^B near A near/)
    expect(refs[a].label).toMatch(/^A near B near/)
  })

  it('reports renamed and deleted targets', () => {
    const p = s.createNode('place', 'Hardware store')
    s.updateText(p, 'Home Depot')
    expect(s.getRefs([p])[p]).toMatchObject({ label: 'Home Depot', deleted: false, exists: true })
    s.deleteSubtree(p)
    expect(s.getRefs([p])[p].deleted).toBe(true)
    const missing = '00000000-0000-4000-8000-000000000000'
    expect(s.getRefs([missing])[missing].exists).toBe(false)
  })
})

describe('node view and backlinks', () => {
  it('shows backlinks across pads with breadcrumbs, open first', () => {
    const store = s.createNode('place', 'Hardware store')
    const other = s.createPad('House')
    const { elbows } = build(pad, ['plumbing', ['elbows']])
    const { bulbs, tape } = build(other, ['bulbs', 'tape'])
    for (const id of [elbows, bulbs, tape]) s.updateText(id, `${s.getNode(id)!.text} ${makeToken(store)}`)
    s.setDone(bulbs, true)
    const view = s.getNodeView(store)
    expect(view.backlinks.map((b) => b.source.id)).toEqual([tape, elbows, bulbs])
    expect(view.backlinks[1].crumbs.map((c) => c.label)).toEqual(['Project', 'plumbing'])
    // Checking off from the backlinks list is the same node everywhere.
    s.setDone(elbows, true)
    expect(s.getTree(pad).children[0].children[0].done).toBe(true)
  })

  it('hides backlinks from deleted sources', () => {
    const p = s.createNode('place', 'P')
    const { a } = build(pad, ['a'])
    s.updateText(a, makeToken(p))
    s.deleteSubtree(a)
    expect(s.getBacklinks(p)).toEqual([])
  })

  it('includes refs for every token in the view', () => {
    const p = s.createNode('place', 'P')
    const { a } = build(pad, ['x', ['a']])
    s.updateText(a, `at ${makeToken(p)}`)
    const view = s.getNodeView(pad)
    expect(view.refs[p].label).toBe('P')
    expect(view.ancestors).toEqual([])
    expect(s.getNodeView(a).ancestors.map((c) => c.label)).toEqual(['Project', 'x'])
    expect(s.getNodeView(a).outgoing.map((r) => r.id)).toEqual([p])
  })

  it('lists places and people with open backlink counts', () => {
    const p = s.createNode('place', 'Zoo')
    s.createNode('place', 'aquarium')
    const { a, b } = build(pad, ['a', 'b'])
    s.updateText(a, makeToken(p))
    s.updateText(b, makeToken(p))
    s.setDone(b, true)
    const places = s.listByKind('place')
    expect(places.map((x) => x.label)).toEqual(['aquarium', 'Zoo'])
    expect(places[1]).toMatchObject({ openBacklinks: 1, totalBacklinks: 2 })
  })
})

describe('pads', () => {
  it('lists pads in order with item counts', () => {
    const b = s.createPad('B')
    build(pad, ['a', ['a1'], 'done'])
    s.setDone(s.getChildren(pad)[1].id, true)
    const pads = s.listPads()
    expect(pads.map((p) => p.label)).toEqual(['Project', 'B'])
    expect(pads[0]).toMatchObject({ itemCount: 3, openCount: 2 })
    expect(pads[1]).toMatchObject({ itemCount: 0, openCount: 0 })
    s.reorderPad(b, null)
    expect(s.listPads().map((p) => p.label)).toEqual(['B', 'Project'])
    s.reorderPad(b, pad)
    expect(s.listPads().map((p) => p.label)).toEqual(['Project', 'B'])
  })

  it('hides deleted pads', () => {
    s.deleteSubtree(pad)
    expect(s.listPads()).toEqual([])
  })
})

describe('search', () => {
  it('finds nodes fuzzily with breadcrumb context', () => {
    const store = s.createNode('place', 'Hardware store')
    build(pad, ['plumbing', ['3/4 inch PVC elbows']])
    const r = s.search('hard')
    expect(r[0].id).toBe(store)
    const e = s.search('pvc elb')
    expect(e[0]).toMatchObject({ label: '3/4 inch PVC elbows', context: 'Project › plumbing' })
    expect(s.search('hdwr')[0]?.id).toBe(store)
    expect(s.search('zzzz')).toEqual([])
  })

  it('filters by kind and excludes ids', () => {
    const p = s.createNode('place', 'Store')
    s.createNode('person', 'Store clerk')
    expect(s.search('store', { kinds: ['person'] }).map((r) => r.label)).toEqual(['Store clerk'])
    expect(s.search('store', { excludeIds: [p] }).map((r) => r.label)).toEqual(['Store clerk'])
  })

  it('skips deleted nodes', () => {
    const p = s.createNode('place', 'Store')
    s.deleteSubtree(p)
    expect(s.search('store')).toEqual([])
  })
})

describe('neighborhood', () => {
  it('walks child and link edges both ways up to N hops', () => {
    const place = s.createNode('place', 'Store')
    const { a, a1 } = build(pad, ['a', ['a1'], 'b'])
    s.updateText(a1, makeToken(place))
    const n1 = s.getNeighborhood(place, 1)
    expect(n1.nodes.map((n) => n.id).sort()).toEqual([place, a1].sort())
    const n2 = s.getNeighborhood(place, 2)
    expect(n2.nodes.map((n) => n.id)).toContain(a)
    expect(n2.edges).toContainEqual({ src: a1, dst: place, type: 'link' })
    expect(n2.edges).toContainEqual({ src: a, dst: a1, type: 'child' })
  })

  it('truncates at maxNodes', () => {
    build(pad, ['a', 'b', 'c', 'd', 'e'])
    const n = s.getNeighborhood(pad, 2, 3)
    expect(n.nodes).toHaveLength(3)
    expect(n.truncated).toBe(true)
  })
})

describe('export / import', () => {
  it('round-trips into a fresh database', async () => {
    const place = s.createNode('place', 'Store')
    const { a, gone } = build(pad, ['a', ['a1'], 'gone'])
    s.updateText(a, `a ${makeToken(place)}`)
    s.deleteSubtree(gone)
    const file = JSON.parse(JSON.stringify(s.exportAll()))

    const fresh = await makeStore()
    expect(fresh.importAll(file)).toEqual({ nodes: file.nodes.length, edges: file.edges.length })
    expect(shape(fresh, pad)).toEqual([`a ${makeToken(place)}`, ['a1']])
    expect(fresh.getBacklinks(place).map((b) => b.source.id)).toEqual([a])
    expect(fresh.listPads().map((p) => p.label)).toEqual(['Project'])
    expect(fresh.listDeleted().map((d) => d.label)).toEqual(['gone'])
  })

  it('replaces existing data', async () => {
    const file = s.exportAll()
    const other = await makeStore()
    other.createPad('Will be replaced')
    other.importAll(file)
    expect(other.listPads().map((p) => p.label)).toEqual(['Project'])
  })

  it('rejects malformed files without touching data', () => {
    const before = s.exportAll()
    expect(() => s.importAll({ app: 'nope' })).toThrow(/Invalid export/)
    const twoParents = {
      ...before,
      nodes: [...before.nodes, { ...before.nodes[0], id: 'n2', kind: 'item', sort_key: null }],
      edges: [
        { id: 'e1', src: pad, dst: 'n2', type: 'child', sort_key: 'a0', created_at: 0 },
        { id: 'e2', src: pad, dst: 'n2', type: 'child', sort_key: 'a1', created_at: 0 },
      ],
    }
    expect(() => s.importAll(twoParents)).toThrow(/two parents/)
    const cycle = {
      ...before,
      nodes: [
        { ...before.nodes[0], id: 'x', kind: 'item' },
        { ...before.nodes[0], id: 'y', kind: 'item' },
      ],
      edges: [
        { id: 'e1', src: 'x', dst: 'y', type: 'child', sort_key: 'a0', created_at: 0 },
        { id: 'e2', src: 'y', dst: 'x', type: 'child', sort_key: 'a0', created_at: 0 },
      ],
    }
    expect(() => s.importAll(cycle)).toThrow(/cycle/)
    const dangling = { ...before, edges: [{ id: 'e', src: pad, dst: 'nope', type: 'link', created_at: 0 }] }
    expect(() => s.importAll(dangling)).toThrow(/missing node/)
    expect(s.listPads().map((p) => p.label)).toEqual(['Project'])
  })

  it('rejects files from a newer schema', () => {
    const file = { ...s.exportAll(), schema_version: 999 }
    expect(() => s.importAll(file)).toThrow(/newer version/)
  })
})

describe('client-chosen ids', () => {
  it('uses the id the caller provides', () => {
    const id = '0f0e0d0c-0b0a-4908-8706-050403020100'
    expect(s.createChild(pad, undefined, { id, text: 'x' })).toBe(id)
    expect(s.getNode(id)?.text).toBe('x')
    const n2 = 'aaaaaaaa-0b0a-4908-8706-050403020100'
    expect(s.splitNode(id, 'a', 'b', n2)).toBe(n2)
    expect(shape(s, pad)).toEqual(['a', 'b'])
  })

  it('rejects duplicate or malformed ids', () => {
    const id = s.createChild(pad)
    expect(() => s.createChild(pad, undefined, { id })).toThrow(/exists/)
    expect(() => s.createChild(pad, undefined, { id: 'nope' })).toThrow(/Bad id/)
  })
})

describe('inbox and seed', () => {
  it('files new items into a single inbox pad', () => {
    const a = s.createInInbox({ text: 'one' })
    const b = s.createInInbox({ text: 'two' })
    const inbox = s.inboxId()
    expect(shape(s, inbox)).toEqual(['one', 'two'])
    expect(s.getAncestors(a)[0].label).toBe('Inbox')
    expect(s.getAncestors(b)[0].id).toBe(inbox)
  })

  it('seeds a welcome pad only into an empty database', async () => {
    expect(s.seedIfEmpty()).toBeNull()
    const fresh = await makeStore()
    const pad = fresh.seedIfEmpty()
    expect(pad).not.toBeNull()
    expect(fresh.listPads().map((p) => p.label)).toEqual(['Welcome'])
    expect(fresh.listByKind('place')[0]).toMatchObject({ label: 'Hardware store', openBacklinks: 2 })
    expect(fresh.seedIfEmpty()).toBeNull()
  })
})

describe('malformed sort keys from imports', () => {
  it('re-keys children with invalid fractional keys instead of failing', () => {
    const { a, b, c } = build(pad, ['a', 'b', 'c'])
    s.db.exec(`UPDATE edges SET sort_key = 'a0200' WHERE dst = ?`, [a])
    s.db.exec(`UPDATE edges SET sort_key = 'a0300' WHERE dst = ?`, [b])
    s.db.exec(`UPDATE edges SET sort_key = 'a0400' WHERE dst = ?`, [c])
    s.createSibling(b, 'after', { text: 'b2' })
    expect(shape(s, pad)).toEqual(['a', 'b', 'b2', 'c'])
    expect(s.moveUp(c)).toBe(true)
    expect(shape(s, pad)).toEqual(['a', 'b', 'c', 'b2'])
  })

  it('re-keys pads with invalid keys', () => {
    const other = s.createPad('Other')
    s.db.exec(`UPDATE nodes SET sort_key = 'a0100' WHERE id = ?`, [pad])
    s.db.exec(`UPDATE nodes SET sort_key = 'a0900' WHERE id = ?`, [other])
    s.createPad('Third')
    expect(s.listPads().map((p) => p.label)).toEqual(['Project', 'Other', 'Third'])
    s.reorderPad(other, null)
    expect(s.listPads().map((p) => p.label)).toEqual(['Other', 'Project', 'Third'])
  })
})

describe('insertMany', () => {
  it('inserts several lines after a sibling, in order', () => {
    const { a } = build(pad, ['a', 'z'])
    const ids = s.insertMany({ after: a }, [{ text: 'b' }, { text: 'c' }, { text: 'd' }])
    expect(ids).toHaveLength(3)
    expect(shape(s, pad)).toEqual(['a', 'b', 'c', 'd', 'z'])
  })

  it('inserts as first or last children', () => {
    build(pad, ['m'])
    s.insertMany({ parent: pad, position: 'first' }, [{ text: 'a' }, { text: 'b' }])
    s.insertMany({ parent: pad, position: 'last' }, [{ text: 'y' }, { text: 'z' }])
    expect(shape(s, pad)).toEqual(['a', 'b', 'm', 'y', 'z'])
  })

  it('is all-or-nothing', () => {
    const { a } = build(pad, ['a'])
    expect(() => s.insertMany({ after: a }, [{ text: 'ok' }, { id: 'bad', text: 'x' }])).toThrow()
    expect(shape(s, pad)).toEqual(['a'])
  })
})

describe('convertToHub', () => {
  it('turns a line into a standalone place and leaves a link in its spot', () => {
    const { garden, x } = build(pad, ['garden', ['x'], 'after'])
    s.updateText(garden, 'Garden center')
    const place = s.convertToHub(garden, 'place')
    expect(place).not.toBe(garden)
    expect(s.getNode(place)).toMatchObject({ kind: 'place', text: 'Garden center' })
    expect(s.getAncestors(place)).toEqual([])
    expect(s.getNode(garden)?.text).toBe(makeToken(place))
    expect(s.getChildren(garden).map((c) => c.id)).toEqual([x])
    expect(s.getBacklinks(place).map((b) => b.source.id)).toEqual([garden])
    expect(s.listByKind('place').map((p) => p.label)).toEqual(['Garden center'])
    expect(s.search('garden')[0]).toMatchObject({ id: place, kind: 'place', context: '' })
  })

  it('relabels a node that has no parent', () => {
    const loose = s.createNode('item', 'Sam')
    expect(s.convertToHub(loose, 'person')).toBe(loose)
    expect(s.getNode(loose)?.kind).toBe('person')
  })

  it('keeps links that were in the line on the new place', () => {
    const city = s.createNode('place', 'Springfield')
    const { a } = build(pad, ['a'])
    s.updateText(a, `Garden center in ${makeToken(city)}`)
    const place = s.convertToHub(a, 'place')
    expect(s.getBacklinks(city).map((b) => b.source.id)).toEqual([place])
  })

  it('refuses pads', () => {
    expect(() => s.convertToHub(pad, 'place')).toThrow(/pad/)
  })
})

describe('listBrowse', () => {
  it('lists pads at the top level and live children below, with counts', () => {
    const other = s.createPad('Other')
    const { a, gone } = build(pad, ['a', ['a1', 'a2'], 'gone', 'b'])
    s.deleteSubtree(gone)
    expect(s.listBrowse(null).map((r) => [r.label, r.childCount])).toEqual([
      ['Project', 2],
      ['Other', 0],
    ])
    expect(s.listBrowse(pad).map((r) => [r.label, r.childCount])).toEqual([
      ['a', 2],
      ['b', 0],
    ])
    expect(s.listBrowse(a).map((r) => r.label)).toEqual(['a1', 'a2'])
    expect(s.listBrowse(other)).toEqual([])
  })
})

describe('numbered lists', () => {
  it('stores the flag and reports it in the tree', () => {
    const { a } = build(pad, ['a', ['a1', 'a2']])
    expect(s.getTree(pad).children[0].numbered).toBe(false)
    s.setNumbered(a, true)
    expect(s.getTree(pad).children[0].numbered).toBe(true)
    expect(s.getNode(a)?.numbered).toBe(true)
  })

  it('gives child edges of numbered parents their position in the graph', () => {
    const { a, a1, a2, a3, gone } = build(pad, ['a', ['a1', 'gone', 'a2', 'a3']])
    s.deleteSubtree(gone)
    s.setNumbered(a, true)
    s.moveUp(a3)
    const g = s.getNeighborhood(a, 1)
    const idx = (dst: string) => g.edges.find((e) => e.type === 'child' && e.dst === dst)?.index
    expect([idx(a1), idx(a3), idx(a2)]).toEqual([0, 1, 2])
    // Unnumbered parents' edges have no index.
    expect(g.edges.find((e) => e.dst === a)?.index).toBeUndefined()
  })

  it('round-trips through export and imports older files without the flag', async () => {
    const { a } = build(pad, ['a', ['a1']])
    s.setNumbered(a, true)
    const file = JSON.parse(JSON.stringify(s.exportAll()))
    const fresh = await makeStore()
    fresh.importAll(file)
    expect(fresh.getNode(a)?.numbered).toBe(true)
    for (const n of file.nodes) delete n.numbered
    const old = await makeStore()
    old.importAll({ ...file, schema_version: 2 })
    expect(old.getNode(a)?.numbered).toBe(false)
  })
})

describe('to-dos and bullets', () => {
  const task = (id: string) => s.getNode(id)!.task

  it('new items continue the kind of the item next to them', () => {
    const a = s.createChild(pad) // the first line of a pad: a to-do
    expect(task(a)).toBe(true)
    const note = s.createChild(pad, undefined, { task: false })
    expect(task(note)).toBe(false)
    expect(task(s.createChild(pad))).toBe(false) // appended after a bullet
    expect(task(s.createSibling(a, 'after'))).toBe(true)
    expect(task(s.createSibling(note, 'before'))).toBe(false)
    expect(task(s.createChild(pad, null))).toBe(true) // first, ahead of a to-do
    expect(task(s.createChild(pad, note))).toBe(false) // right after a bullet
    expect(task(s.splitNode(note, 'no', 'te'))).toBe(false)
    expect(task(s.createChild(note))).toBe(true) // first child of anything but a place/person
  })

  it('starts notes under a place or person as bullets', () => {
    const place = s.createNode('place', 'Shop')
    expect(task(s.createChild(place))).toBe(false)
  })

  it('makes items from the link picker bullets', () => {
    expect(task(s.createInInbox({ text: 'waiting' }))).toBe(false)
  })

  it('lets only to-dos be done', () => {
    const note = s.createChild(pad, undefined, { task: false })
    s.setDone(note, true) // checking off a bullet makes it a to-do
    expect(s.getNode(note)).toMatchObject({ task: true, done: true })
    s.setTask(note, false)
    expect(s.getNode(note)).toMatchObject({ task: false, done: false })
    s.setTask(note, true)
    expect(s.getNode(note)).toMatchObject({ task: true, done: false })
  })

  it('never makes places, people or pads to-dos', () => {
    const place = s.createNode('place', 'Shop')
    expect(() => s.setDone(place, true)).toThrow(/Only items/)
    expect(() => s.setTask(place, true)).toThrow(/Only items/)
    s.setTask(place, false) // already true: fine
    expect(task(pad)).toBe(false)
    const a = s.createChild(pad, undefined, { text: 'x' })
    s.setDone(a, true)
    s.setKind(a, 'person')
    expect(s.getNode(a)).toMatchObject({ task: false, done: false })
    // Turning a to-do line into a person: the person isn't a to-do, the line still is.
    const line = s.createChild(pad, undefined, { text: 'Bob' })
    const hub = s.convertToHub(line, 'person')
    expect(task(hub)).toBe(false)
    expect(task(line)).toBe(true)
  })

  it('switches every item directly inside at once', () => {
    const { a, a1, a2, a2x } = build(pad, ['a', ['a1', 'a2', ['a2x']]])
    s.setDone(a1, true)
    expect(s.setChildrenTask(a, false)).toBe(2)
    expect([task(a1), task(a2), task(a2x)]).toEqual([false, false, true])
    expect(s.getNode(a1)!.done).toBe(false)
    expect(s.setChildrenTask(a, false)).toBe(0)
  })

  it('lets inserted lines carry their own checkboxes', () => {
    const a = s.createChild(pad, undefined, { task: false })
    const [x, y, z] = s.insertMany({ after: a }, [{ text: 'x' }, { text: 'y', task: true, done: true }, { text: 'z' }])
    expect([task(x), task(y), task(z)]).toEqual([false, true, true])
    expect(s.getNode(y)!.done).toBe(true)
    const [w] = s.insertMany({ after: a }, [{ text: 'w', task: false, done: true }])
    expect(s.getNode(w)).toMatchObject({ task: false, done: false })
  })

  it('counts only to-dos as open', () => {
    const { a, b } = build(pad, ['a', 'b'])
    s.createChild(pad, undefined, { text: 'note', task: false })
    s.setDone(b, true)
    expect(s.listPads().find((x) => x.id === pad)).toMatchObject({ itemCount: 3, taskCount: 2, openCount: 1 })
    const place = s.createNode('place', 'Shop')
    const t = makeToken(place)
    s.updateText(a, `a ${t}`)
    s.updateText(b, `b ${t}`)
    s.createChild(pad, undefined, { text: `closes at 6 ${t}`, task: false })
    expect(s.listByKind('place')[0]).toMatchObject({ openBacklinks: 1, totalBacklinks: 3 })
  })

  it('lists backlinks as open to-dos, then mentions, then done', () => {
    const place = s.createNode('place', 'Shop')
    const t = makeToken(place)
    const done = s.createChild(pad, undefined, { text: `done ${t}` })
    s.setDone(done, true)
    const note = s.createChild(pad, undefined, { text: `note ${t}`, task: false })
    const open = s.createChild(pad, undefined, { text: `open ${t}`, task: true })
    const other = s.createPad(`pad ${t}`)
    const order = s.getBacklinks(place).map((b) => b.source.id)
    expect(order[0]).toBe(open)
    expect(new Set(order.slice(1, 3))).toEqual(new Set([note, other]))
    expect(order[3]).toBe(done)
  })

  it('counts what links to each row, leaving out finished to-dos and deleted lines', () => {
    const states = s.createPad('States')
    const waiting = s.createChild(states, undefined, { text: 'waiting', task: false })
    const t = makeToken(waiting)
    const { a, b, c } = build(pad, ['a', 'b', 'c'])
    s.updateText(a, `a ${t}`)
    s.updateText(b, `b ${t}`)
    s.updateText(c, `c ${t}`)
    expect(s.getTree(states).children[0].links).toBe(3)
    s.setDone(a, true)
    s.deleteSubtree(b)
    expect(s.getTree(states).children[0].links).toBe(1)
    expect(s.getTree(pad).children.map((ch) => ch.links)).toEqual([0, 0])
  })

  it('migrates older databases: items become to-dos, nothing else stays done', async () => {
    const db = await makeDb()
    for (const m of MIGRATIONS.filter((m) => m.version <= 3)) db.exec(m.sql)
    db.exec("INSERT INTO meta (key, value) VALUES ('schema_version', '3')")
    const ins = `INSERT INTO nodes (id, kind, text, done, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)`
    db.exec(ins, ['i', 'item', 'milk', 1])
    db.exec(ins, ['j', 'item', 'eggs', 0])
    db.exec(ins, ['p', 'place', 'Shop', 1])
    const old = await makeStore({ db })
    expect(old.info().schemaVersion).toBe(LATEST_SCHEMA_VERSION)
    expect(old.getNode('i')).toMatchObject({ task: true, done: true })
    expect(old.getNode('j')).toMatchObject({ task: true, done: false })
    expect(old.getNode('p')).toMatchObject({ task: false, done: false })
  })

  it('round-trips through export and imports older files as to-dos', async () => {
    const note = s.createChild(pad, undefined, { text: 'note', task: false })
    const todo = s.createChild(pad, undefined, { text: 'todo', task: true })
    const file = JSON.parse(JSON.stringify(s.exportAll()))
    const fresh = await makeStore()
    fresh.importAll(file)
    expect([fresh.getNode(note)!.task, fresh.getNode(todo)!.task]).toEqual([false, true])
    for (const n of file.nodes) delete n.task
    const old = await makeStore()
    old.importAll({ ...file, schema_version: 3 })
    expect([old.getNode(note)!.task, old.getNode(todo)!.task, old.getNode(pad)!.task]).toEqual([true, true, false])
  })
})

describe('link phrases', () => {
  it('records what each link means and keeps it current as the text changes', () => {
    const place = s.createNode('place', 'Shop')
    const sam = s.createNode('person', 'Sam')
    const x = s.createChild(pad, undefined, { text: `Buy elbows at ${makeToken(place)}, ask ${makeToken(sam)}` })
    const phraseTo = (dst: string) => s.getBacklinks(dst).find((b) => b.source.id === x)?.phrase
    expect([phraseTo(place), phraseTo(sam)]).toEqual(['buy at', 'ask'])
    s.updateText(x, `Return the clamp to ${makeToken(place)}`)
    expect(phraseTo(place)).toBe('return to')
    expect(s.getNeighborhood(x, 1).edges.find((e) => e.dst === place)?.phrase).toBe('return to')
  })

  it('fills in phrases for links made before phrases existed', async () => {
    const place = s.createNode('place', 'Shop')
    const x = s.createChild(pad, undefined, { text: `waiting on ${makeToken(place)}` })
    s.db.exec(`UPDATE edges SET phrase = NULL`)
    s.db.exec(`DELETE FROM meta WHERE key = 'link_phrases'`)
    const reopened = await makeStore({ db: s.db })
    expect(reopened.getBacklinks(place).map((b) => [b.source.id, b.phrase])).toEqual([[x, 'waiting on']])
  })
})

describe('import and link phrases', () => {
  it('works out link phrases for imported lines', async () => {
    const place = s.createNode('place', 'Shop')
    s.createChild(pad, undefined, { text: `Buy elbows at ${makeToken(place)}` })
    const file = JSON.parse(JSON.stringify(s.exportAll()))
    const fresh = await makeStore()
    fresh.importAll(file)
    expect(fresh.getBacklinks(place).map((b) => b.phrase)).toEqual(['buy at'])
  })
})

describe('your relations', () => {
  function setupLinks() {
    const shop = s.createNode('place', 'Shop')
    const sam = s.createNode('person', 'Sam')
    const t = makeToken
    const a = s.createChild(pad, undefined, { text: `Buy elbows at ${t(shop)}` })
    const b = s.createChild(pad, undefined, { text: `Pick up tape at ${t(shop)}` })
    const c = s.createChild(pad, undefined, { text: `Get mulch from ${t(shop)}` })
    const d = s.createChild(pad, undefined, { text: `Lunch with ${t(sam)}` })
    return { shop, sam, a, b, c, d }
  }
  const labels = (dst: string) =>
    Object.fromEntries(s.getBacklinks(dst).map((b) => [b.source.text.split(' ')[0], b.phrase]))

  it('starts with suggestions only', () => {
    const { shop } = setupLinks()
    expect(labels(shop)).toEqual({ Buy: 'buy at', Pick: 'pick up at', Get: 'get from' })
    const r = s.listRelations()
    expect(r.relations).toEqual([])
    expect(r.suggestions.map((x) => [x.phrase, x.count])).toContainEqual(['buy at', 1])
  })

  it('keeps a phrase, and folds other wordings into it', () => {
    const { shop } = setupLinks()
    const buy = s.keepRelation('buy at')
    s.keepRelation('pick up at', 'buy at')
    s.keepRelation('get from', 'Buy At')
    expect(labels(shop)).toEqual({ Buy: 'buy at', Pick: 'buy at', Get: 'buy at' })
    const [rel] = s.listRelations().relations
    expect(rel).toMatchObject({ id: buy, name: 'buy at', count: 3 })
    expect(rel.aliases.map((a) => a.text)).toEqual(['pick up at', 'get from'])
    expect(s.getBacklinks(shop).every((b) => b.relationId === buy)).toBe(true)
    expect(s.getRelationLinks({ relationId: buy }).map((l) => l.target.id)).toEqual([shop, shop, shop])
    // Relations stay out of search and the link picker, unless asked for.
    expect(s.search('buy').some((x) => x.kind === 'relation')).toBe(false)
    expect(s.search('buy', { kinds: ['relation'] }).map((x) => x.id)).toEqual([buy])
  })

  it('renames a relation, and the old name still counts', () => {
    const { shop } = setupLinks()
    const buy = s.keepRelation('buy at')
    s.renameRelation(buy, 'shop at')
    expect(labels(shop).Buy).toBe('shop at')
    expect(s.listRelations().relations[0].aliases.map((a) => a.text)).toEqual(['buy at'])
    // Renaming onto another relation merges them.
    const get = s.keepRelation('get from')
    s.renameRelation(get, 'shop at')
    expect(labels(shop)).toMatchObject({ Buy: 'shop at', Get: 'shop at' })
    expect(s.listRelations().relations).toHaveLength(1)
  })

  it('merges relations, including links pinned to the one going away', () => {
    const { shop, b } = setupLinks()
    const buy = s.keepRelation('buy at')
    const get = s.keepRelation('get from')
    s.setLinkRelation(b, shop, get)
    expect(labels(shop).Pick).toBe('get from')
    s.mergeRelation(get, buy)
    expect(labels(shop)).toEqual({ Buy: 'buy at', Pick: 'buy at', Get: 'buy at' })
    expect(s.getBacklinks(shop).find((x) => x.source.id === b)?.pinned).toBe(true)
  })

  it('rules phrases out, and lets them back in', () => {
    const { sam, d } = setupLinks()
    s.ignorePhrase('with')
    expect(s.getBacklinks(sam)[0]).toMatchObject({ phrase: null, relationId: NO_RELATION_ID, suggested: 'with' })
    expect(s.listRelations().ignored.map((x) => x.text)).toEqual(['with'])
    expect(s.listRelations().relations).toEqual([]) // "Not a relation" isn't listed as one
    s.keepRelation('with', 'lunch with')
    expect(s.getBacklinks(sam)[0].phrase).toBe('lunch with')
    expect(s.listRelations().ignored).toEqual([])
    s.setLinkRelation(d, sam, NO_RELATION_ID)
    expect(s.getBacklinks(sam)[0]).toMatchObject({ phrase: null, pinned: true })
    s.setLinkRelation(d, sam, null)
    expect(s.getBacklinks(sam)[0]).toMatchObject({ phrase: 'lunch with', pinned: false })
  })

  it('pins a link to a relation even when its wording changes', () => {
    const { shop, a } = setupLinks()
    const get = s.keepRelation('get from')
    s.setLinkRelation(a, shop, get)
    s.updateText(a, `Order bolts from ${makeToken(shop)}`)
    expect(s.getBacklinks(shop).find((x) => x.source.id === a)?.phrase).toBe('get from')
    expect(s.getNeighborhood(a, 1).edges.find((e) => e.dst === shop)?.phrase).toBe('get from')
  })
})

describe('contexts and their kinds', () => {
  it('starts with Places (in the bar) and People (not), which older places and people belong to', () => {
    const cats = s.listCategories()
    expect(cats.map((c) => [c.id, c.name, c.pinned])).toEqual([
      [PLACES_ID, 'Places', true],
      [PEOPLE_ID, 'People', false],
    ])
    const shop = s.createNode('place', 'Shop')
    expect(s.getNode(shop)?.category).toBe(PLACES_ID)
    expect(s.listContexts(PLACES_ID).map((c) => c.label)).toEqual(['Shop'])
    expect(s.search('').some((r) => r.kind === 'category')).toBe(false)
  })

  it('makes kinds of your own, and lets any line be a context where it is', () => {
    const rooms = s.createCategory('Rooms', { icon: 'home' })
    const garage = s.createChild(pad, undefined, { text: 'Garage' })
    s.setCategory(garage, rooms)
    expect(s.getNode(garage)?.category).toBe(rooms)
    expect(shape(s, pad)).toEqual(['Garage']) // still in its list
    const t = s.createChild(pad, undefined, { text: `Sweep the ${makeToken(garage)}` })
    expect(s.listContexts(rooms)).toMatchObject([{ id: garage, openBacklinks: 1, totalBacklinks: 1 }])
    expect(s.listCategories().find((c) => c.id === rooms)).toMatchObject({ name: 'Rooms', icon: 'home', count: 1, open: 1 })
    s.setDone(t, true)
    expect(s.listCategories().find((c) => c.id === rooms)?.open).toBe(0)
    // Notes under a context start as bullets.
    expect(s.getNode(s.createChild(garage))!.task).toBe(false)
    // Its chips take the kind's colour.
    expect(s.getRefs([garage])[garage].tone).toBe(s.listCategories().find((c) => c.id === rooms)!.tone)
  })

  it('pins kinds to the bar and changes their icon', () => {
    const projects = s.createCategory('Projects')
    s.setCategoryProps(projects, { pinned: true, icon: 'folder' })
    s.setCategoryProps(PLACES_ID, { pinned: false })
    expect(s.listCategories().map((c) => [c.name, c.pinned, c.icon])).toEqual([
      ['Places', false, 'pin'],
      ['People', false, 'person'],
      ['Projects', true, 'folder'],
    ])
  })

  it('turns a line in a list into a context it links to', () => {
    const projects = s.createCategory('Projects')
    const line = s.createChild(pad, undefined, { text: 'Kitchen remodel' })
    const ctx = s.convertToContext(line, projects)
    expect(ctx).not.toBe(line)
    expect(s.getNode(line)!.text).toBe(makeToken(ctx))
    expect(s.getNode(ctx)).toMatchObject({ text: 'Kitchen remodel', category: projects })
    expect(s.listContexts(projects).map((c) => c.label)).toEqual(['Kitchen remodel'])
  })

  it('stops being a context, including older places', () => {
    const shop = s.createNode('place', 'Shop')
    s.setCategory(shop, null)
    expect(s.getNode(shop)).toMatchObject({ kind: 'item', category: null })
    expect(s.listContexts(PLACES_ID)).toEqual([])
  })

  it('suggests a kind from how a thing is linked to', () => {
    const shop = s.createNode('place', 'Shop')
    s.createChild(pad, undefined, { text: `Buy elbows at ${makeToken(shop)}` })
    s.createChild(pad, undefined, { text: `Buy tape at ${makeToken(shop)}` })
    const nursery = s.createChild(pad, undefined, { text: 'Plant nursery' })
    s.createChild(pad, undefined, { text: `Buy soil at ${makeToken(nursery)}` })
    const maya = s.createChild(pad, undefined, { text: 'Maya' })
    s.createChild(pad, undefined, { text: `Lunch with ${makeToken(maya)}` })
    const others = s.listOtherContexts()
    expect(others.find((o) => o.id === nursery)).toMatchObject({ suggested: PLACES_ID, openBacklinks: 1 })
    expect(others.find((o) => o.id === maya)?.suggested).toBeNull() // nothing like "with" among People yet
    expect(s.getNodeView(nursery).suggestedCategory).toBe(PLACES_ID)
    s.setCategory(nursery, PLACES_ID)
    expect(s.listOtherContexts().map((o) => o.id)).not.toContain(nursery)
  })

  it('keeps the built-in kinds through joining a server and importing older files', async () => {
    const fresh = await makeStore()
    fresh.seedIfEmpty()
    expect(fresh.syncPrepareJoin()).toBe(true)
    expect(fresh.listCategories().map((c) => c.id)).toEqual([PLACES_ID, PEOPLE_ID])
    const file = JSON.parse(JSON.stringify(s.exportAll()))
    file.nodes = file.nodes.filter((n: { kind: string }) => n.kind !== 'category')
    const old = await makeStore()
    old.importAll(file)
    expect(old.listCategories().map((c) => c.id)).toEqual([PLACES_ID, PEOPLE_ID])
  })
})
