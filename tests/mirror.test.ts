// The outline applies tree operations optimistically to a local copy
// (src/lib/treeOps.ts) before the store does them. Both must agree exactly,
// or the UI would briefly (or, while focused, persistently) show the wrong tree.
import { describe, expect, it } from 'vitest'
import { makeStore } from './helpers'
import * as T from '../src/lib/treeOps'
import type { TreeNode } from '../src/db/types'

function strip(t: TreeNode): unknown {
  return { id: t.id, done: t.done, task: t.task, collapsed: t.collapsed, children: t.children.map(strip) }
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
      for (let i = 0; i < 6; i++) s.createChild(pad, undefined, { text: `n${i}`, task: i % 2 === 0 })
      let local = s.getTree(pad)
      const pick = () => {
        const rows = T.flatten(local)
        return rows.length ? rows[Math.floor(rand() * rows.length)].node.id : null
      }
      // New nodes: the local copy picks to-do vs bullet with T.taskFor, the
      // store with its own default (no task passed), and they must agree.
      const fresh = (parent: TreeNode, near: TreeNode | undefined) => T.newNode(crypto.randomUUID(), { task: T.taskFor(parent, near) })
      const near = (id: string) => {
        const at = T.locate(local, id)!
        return { parent: at.parent!, node: at.node }
      }
      for (let step = 0; step < 150; step++) {
        const id = pick()
        const op = Math.floor(rand() * 11)
        if (!id) {
          const n = fresh(local, local.children[local.children.length - 1])
          T.insertChild(local, pad, 'last', n)
          s.createChild(pad, undefined, { id: n.id })
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
          case 4: {
            const { parent, node } = near(id)
            const n = fresh(parent, node)
            T.insertSibling(local, id, 'after', n)
            s.createSibling(id, 'after', { id: n.id })
            break
          }
          case 5: {
            const { parent, node } = near(id)
            const n = fresh(parent, node)
            T.insertSibling(local, id, 'before', n)
            s.createSibling(id, 'before', { id: n.id })
            break
          }
          case 6: {
            // insertChild expands the parent; so does the UI (Enter on an expanded row).
            const { node } = near(id)
            const first = rand() < 0.5
            const n = fresh(node, first ? node.children[0] : node.children[node.children.length - 1])
            T.insertChild(local, id, first ? 'first' : 'last', n)
            s.createChild(id, first ? null : undefined, { id: n.id })
            s.setCollapsed(id, false)
            break
          }
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
          case 9: {
            // Switch to-do / bullet, as the Outline does.
            const n = T.locate(local, id)!.node
            n.task = !n.task
            if (!n.task) n.done = false
            s.setTask(id, n.task)
            break
          }
          case 10: {
            const n = T.locate(local, id)!.node
            n.done = !n.done
            if (n.done) n.task = true
            s.setDone(id, n.done)
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
