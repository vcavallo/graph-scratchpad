// The outline applies tree operations optimistically to a local copy
// (src/lib/treeOps.ts) before the store does them. Both must agree exactly,
// or the UI would briefly (or, while focused, persistently) show the wrong tree.
import { describe, expect, it } from 'vitest'
import { makeStore } from './helpers'
import * as T from '../src/lib/treeOps'
import type { TreeNode } from '../src/db/types'

function strip(t: TreeNode): unknown {
  return { id: t.id, done: t.done, collapsed: t.collapsed, children: t.children.map(strip) }
}

// Small deterministic PRNG so failures are reproducible.
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 2 ** 32
  }
}

describe('optimistic tree ops mirror the store', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`agrees over 150 random operations (seed ${seed})`, async () => {
      const s = await makeStore()
      const rand = rng(seed)
      const pad = s.createPad('P')
      for (let i = 0; i < 6; i++) s.createChild(pad, undefined, { text: `n${i}` })
      let local = s.getTree(pad)
      const pick = () => {
        const rows = T.flatten(local)
        return rows.length ? rows[Math.floor(rand() * rows.length)].node.id : null
      }
      for (let step = 0; step < 150; step++) {
        const id = pick()
        const op = Math.floor(rand() * 9)
        const nid = crypto.randomUUID()
        if (!id) {
          T.insertChild(local, pad, 'last', T.newNode(nid))
          s.createChild(pad, undefined, { id: nid })
          continue
        }
        switch (op) {
          case 0:
            if (T.indent(local, id)) s.indent(id)
            break
          case 1:
            if (T.outdent(local, id)) s.outdent(id)
            break
          case 2:
            if (T.moveUp(local, id)) s.moveUp(id)
            break
          case 3:
            if (T.moveDown(local, id)) s.moveDown(id)
            break
          case 4:
            T.insertSibling(local, id, 'after', T.newNode(nid))
            s.createSibling(id, 'after', { id: nid })
            break
          case 5:
            T.insertSibling(local, id, 'before', T.newNode(nid))
            s.createSibling(id, 'before', { id: nid })
            break
          case 6:
            T.insertChild(local, id, rand() < 0.5 ? 'first' : 'last', T.newNode(nid))
            // insertChild expands the parent; so does the UI (Enter on an expanded row).
            {
              const kids = T.locate(local, id)!.node.children
              const first = kids[0].id === nid
              s.createChild(id, first ? null : undefined, { id: nid })
              s.setCollapsed(id, false)
            }
            break
          case 7:
            T.remove(local, id)
            s.deleteSubtree(id)
            break
          case 8: {
            const at = T.locate(local, id)!
            at.node.collapsed = !at.node.collapsed
            s.setCollapsed(id, at.node.collapsed)
            break
          }
        }
        const truth = s.getTree(pad)
        expect(strip(local), `step ${step}, op ${op}`).toEqual(strip(truth))
        // Like a reload: continue from the database's copy.
        if (rand() < 0.2) local = truth
      }
    })
  }
})
