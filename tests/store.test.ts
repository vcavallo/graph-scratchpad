import { beforeEach, describe, expect, it } from 'vitest'
import { makeStore, shape } from './helpers'
import type { Store } from '../src/db/store'
import { MIGRATIONS, LATEST_SCHEMA_VERSION } from '../src/db/migrations'
import { makeToken } from '../src/lib/tokens'

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
