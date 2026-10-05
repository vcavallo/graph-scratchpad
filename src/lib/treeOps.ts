// Optimistic, in-memory mirrors of the store's tree operations, applied to the
// outline's local copy of a TreeNode so the UI updates (and can move focus)
// before the worker round trip. The next reload replaces this copy with the
// database's truth, so any divergence heals itself.

import type { TreeNode } from '@/db/types'

export interface Located {
  node: TreeNode
  parent: TreeNode | null
  index: number
}

export function locate(root: TreeNode, id: string): Located | null {
  if (root.id === id) return { node: root, parent: null, index: 0 }
  const stack: TreeNode[] = [root]
  while (stack.length) {
    const p = stack.pop()!
    const i = p.children.findIndex((c) => c.id === id)
    if (i >= 0) return { node: p.children[i], parent: p, index: i }
    stack.push(...p.children)
  }
  return null
}

export function newNode(id: string, init: { text?: string; task?: boolean; done?: boolean } = {}): TreeNode {
  const task = init.task ?? false
  return {
    id,
    kind: 'item',
    text: init.text ?? '',
    done: task && !!init.done,
    collapsed: false,
    numbered: false,
    task,
    links: 0,
    category: null,
    ref: null,
    children: [],
  }
}

/**
 * Mirror of the store's #taskFor: a new item is a to-do when the item next to
 * it is one. With no neighbouring item it's a to-do, except under a place or person.
 */
export function taskFor(parent: TreeNode, neighbour: TreeNode | undefined): boolean {
  if (neighbour?.kind === 'item') return neighbour.task
  return parent.kind !== 'place' && parent.kind !== 'person'
}

export function insertSibling(root: TreeNode, siblingId: string, where: 'before' | 'after', node: TreeNode): boolean {
  const at = locate(root, siblingId)
  if (!at?.parent) return false
  at.parent.children.splice(where === 'before' ? at.index : at.index + 1, 0, node)
  return true
}

export function insertChild(root: TreeNode, parentId: string, position: 'first' | 'last', node: TreeNode): boolean {
  const at = locate(root, parentId)
  if (!at) return false
  if (position === 'first') at.node.children.unshift(node)
  else at.node.children.push(node)
  at.node.collapsed = false
  return true
}

export function remove(root: TreeNode, id: string): boolean {
  const at = locate(root, id)
  if (!at?.parent) return false
  at.parent.children.splice(at.index, 1)
  return true
}

export function indent(root: TreeNode, id: string): boolean {
  const at = locate(root, id)
  if (!at?.parent || at.index === 0) return false
  const prev = at.parent.children[at.index - 1]
  at.parent.children.splice(at.index, 1)
  prev.children.push(at.node)
  prev.collapsed = false
  return true
}

/** Outdent within the view: refused when the parent is the view's root. */
export function outdent(root: TreeNode, id: string): boolean {
  const at = locate(root, id)
  if (!at?.parent || at.parent === root) return false
  const up = locate(root, at.parent.id)
  if (!up?.parent) return false
  at.parent.children.splice(at.index, 1)
  up.parent.children.splice(up.index + 1, 0, at.node)
  return true
}

export function moveUp(root: TreeNode, id: string): boolean {
  const at = locate(root, id)
  if (!at?.parent || at.index === 0) return false
  const kids = at.parent.children
  ;[kids[at.index - 1], kids[at.index]] = [kids[at.index], kids[at.index - 1]]
  return true
}

export function moveDown(root: TreeNode, id: string): boolean {
  const at = locate(root, id)
  if (!at?.parent || at.index === at.parent.children.length - 1) return false
  const kids = at.parent.children
  ;[kids[at.index + 1], kids[at.index]] = [kids[at.index], kids[at.index + 1]]
  return true
}

export interface FlatRow {
  node: TreeNode
  depth: number
  parentId: string
  isLast: boolean
  hasChildren: boolean
  /** Position among its siblings (0-based). */
  index: number
  /** The parent's children are a numbered list. */
  numbered: boolean
  /** Checked-off and total to-dos directly inside this row, or null if it has none. */
  progress: { done: number; total: number } | null
}

/** Visible rows in document order (children of collapsed nodes skipped). */
export function flatten(root: TreeNode): FlatRow[] {
  const out: FlatRow[] = []
  const walk = (parent: TreeNode, depth: number) => {
    parent.children.forEach((c, i) => {
      const tasks = c.children.filter((k) => k.task)
      out.push({
        node: c,
        depth,
        parentId: parent.id,
        isLast: i === parent.children.length - 1,
        hasChildren: c.children.length > 0,
        index: i,
        numbered: parent.numbered,
        progress: tasks.length ? { done: tasks.filter((k) => k.done).length, total: tasks.length } : null,
      })
      if (!c.collapsed) walk(c, depth + 1)
    })
  }
  walk(root, 0)
  return out
}

export function subtreeIds(node: TreeNode): string[] {
  const out: string[] = []
  const walk = (n: TreeNode) => {
    out.push(n.id)
    n.children.forEach(walk)
  }
  walk(node)
  return out
}
