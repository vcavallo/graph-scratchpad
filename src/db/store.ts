import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing'
import type { SqlDb } from './sql'
import { LATEST_SCHEMA_VERSION, migrate, schemaVersion } from './migrations'
import { labelize, parseTokens } from '../lib/tokens'
import { fuzzyScore } from '../lib/fuzzy'
import {
  KINDS,
  type Backlink,
  type Crumb,
  type DeletedEntry,
  type ExportFile,
  type GraphEdge,
  type GraphNode,
  type ImportResult,
  type IndexEntry,
  type Kind,
  type Neighborhood,
  type NodeInfo,
  type NodeViewData,
  type PadSummary,
  type RawEdge,
  type RawNode,
  type RefInfo,
  type SearchOptions,
  type SearchResult,
  type TreeNode,
} from './types'

export interface StoreDeps {
  now?: () => number
  uuid?: () => string
}

export interface NodeInit {
  text?: string
  kind?: Kind
  /** Client-chosen id (a UUID), so the UI can render and focus the row before the write lands. */
  id?: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Where to put a node among its siblings. */
type Position = { after: string } | { before: string } | 'first' | 'last'

interface SiblingRow {
  edge_id: string
  dst: string
  sort_key: string | null
}

const NODE_COLS = 'id, kind, text, done, collapsed, created_at, updated_at, deleted_at, sort_key'
const MAX_LABEL_DEPTH = 3

export class StoreError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message)
    this.name = 'StoreError'
  }
}

function toInfo(r: RawNode): NodeInfo {
  return {
    id: r.id,
    kind: r.kind,
    text: r.text,
    done: !!r.done,
    collapsed: !!r.collapsed,
    created_at: r.created_at,
    updated_at: r.updated_at,
    deleted: r.deleted_at !== null,
  }
}

function cleanLabel(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function compareKeys(a: { sort_key: string | null; edge_id: string }, b: { sort_key: string | null; edge_id: string }) {
  const ak = a.sort_key ?? ''
  const bk = b.sort_key ?? ''
  if (ak < bk) return -1
  if (ak > bk) return 1
  return a.edge_id < b.edge_id ? -1 : a.edge_id > b.edge_id ? 1 : 0
}

/**
 * The data layer. Every public method is synchronous and runs against a
 * SqlDb; the worker exposes them over postMessage (see api.ts). Methods that
 * change more than one row run in a single transaction.
 */
export class Store {
  readonly db: SqlDb
  #now: () => number
  #uuid: () => string

  constructor(db: SqlDb, deps: StoreDeps = {}) {
    this.db = db
    this.#now = deps.now ?? (() => Date.now())
    this.#uuid = deps.uuid ?? (() => crypto.randomUUID())
    db.exec('PRAGMA foreign_keys = ON')
    migrate(db)
  }

  // ---------------------------------------------------------------- helpers

  #raw(id: string): RawNode | undefined {
    return this.db.get<RawNode>(`SELECT ${NODE_COLS} FROM nodes WHERE id = ?`, [id])
  }

  #requireLive(id: string): RawNode {
    const n = this.#raw(id)
    if (!n) throw new StoreError(`No node ${id}`, 'not_found')
    if (n.deleted_at !== null) throw new StoreError(`Node ${id} is deleted`, 'deleted')
    return n
  }

  #parentEdge(id: string): { id: string; src: string; sort_key: string | null } | undefined {
    return this.db.get(`SELECT id, src, sort_key FROM edges WHERE dst = ? AND type = 'child'`, [id])
  }

  /** All child edges of a parent (live and deleted children), in order. */
  #siblings(parentId: string): SiblingRow[] {
    const rows = this.db.all<SiblingRow>(
      `SELECT id AS edge_id, dst, sort_key FROM edges WHERE src = ? AND type = 'child'`,
      [parentId],
    )
    return rows.sort(compareKeys)
  }

  /** Live child ids of a parent, in order. */
  #liveChildIds(parentId: string): string[] {
    const rows = this.db.all<SiblingRow>(
      `SELECT e.id AS edge_id, e.dst, e.sort_key FROM edges e JOIN nodes n ON n.id = e.dst
       WHERE e.src = ? AND e.type = 'child' AND n.deleted_at IS NULL`,
      [parentId],
    )
    return rows.sort(compareKeys).map((r) => r.dst)
  }

  /** Re-key all children of a parent with fresh, distinct keys in current order. */
  #rekey(parentId: string): void {
    const sibs = this.#siblings(parentId)
    const keys = generateNKeysBetween(null, null, sibs.length)
    sibs.forEach((s, i) => this.db.exec('UPDATE edges SET sort_key = ? WHERE id = ?', [keys[i], s.edge_id]))
  }

  /**
   * A sort key for a new position under parentId. Neighbours are computed over
   * all children, including soft-deleted ones, so keys stay unique and
   * restored nodes come back where they were.
   */
  #keyAt(parentId: string, pos: Position, excludeId?: string, retried = false): string {
    const sibs = this.#siblings(parentId).filter((s) => s.dst !== excludeId)
    let lo: string | null = null
    let hi: string | null = null
    if (pos === 'first') {
      hi = sibs[0]?.sort_key ?? null
    } else if (pos === 'last') {
      lo = sibs[sibs.length - 1]?.sort_key ?? null
    } else {
      const ref = 'after' in pos ? pos.after : pos.before
      const i = sibs.findIndex((s) => s.dst === ref)
      if (i < 0) throw new StoreError(`${ref} is not a child of ${parentId}`, 'bad_sibling')
      if ('after' in pos) {
        lo = sibs[i].sort_key
        hi = sibs[i + 1]?.sort_key ?? null
      } else {
        lo = sibs[i - 1]?.sort_key ?? null
        hi = sibs[i].sort_key
      }
    }
    const broken = (lo !== null && hi !== null && lo >= hi) || sibs.some((s) => s.sort_key === null)
    if (!broken) {
      try {
        return generateKeyBetween(lo, hi)
      } catch {
        // A malformed key (e.g. from a hand-edited import); fall through.
      }
    }
    // Duplicate, missing or malformed keys. Normalise the siblings and retry.
    if (retried) throw new StoreError('Could not compute a sort key', 'sort_key')
    this.#rekey(parentId)
    return this.#keyAt(parentId, pos, excludeId, true)
  }

  #insertNode(kind: Kind, text: string, sortKey: string | null = null, wantedId?: string): string {
    if (wantedId !== undefined) {
      if (!UUID_RE.test(wantedId)) throw new StoreError(`Bad id ${wantedId}`, 'bad_id')
      if (this.#raw(wantedId)) throw new StoreError(`Node ${wantedId} already exists`, 'exists')
    }
    if (!KINDS.includes(kind)) throw new StoreError(`Unknown kind ${kind}`, 'bad_kind')
    const id = wantedId ?? this.#uuid()
    const t = this.#now()
    this.db.exec(
      `INSERT INTO nodes (id, kind, text, done, collapsed, created_at, updated_at, deleted_at, sort_key)
       VALUES (?, ?, ?, 0, 0, ?, ?, NULL, ?)`,
      [id, kind, text, t, t, sortKey],
    )
    if (text) this.#reconcileLinks(id, text)
    return id
  }

  #insertChildEdge(parentId: string, childId: string, key: string): void {
    this.db.exec(
      `INSERT INTO edges (id, src, dst, type, sort_key, created_at) VALUES (?, ?, ?, 'child', ?, ?)`,
      [this.#uuid(), parentId, childId, key, this.#now()],
    )
  }

  /** Make the node's outgoing link edges match the [[uuid]] tokens in its text. */
  #reconcileLinks(id: string, text: string): void {
    const wanted = new Set(parseTokens(text).filter((t) => t !== id))
    const existing = this.db.all<{ id: string; dst: string }>(
      `SELECT id, dst FROM edges WHERE src = ? AND type = 'link'`,
      [id],
    )
    const have = new Set<string>()
    for (const e of existing) {
      if (!wanted.has(e.dst) || have.has(e.dst)) {
        this.db.exec('DELETE FROM edges WHERE id = ?', [e.id])
      } else {
        have.add(e.dst)
      }
    }
    const missing = [...wanted].filter((d) => !have.has(d))
    if (missing.length === 0) return
    const present = new Set(
      this.db
        .all<{ id: string }>(`SELECT id FROM nodes WHERE id IN (SELECT value FROM json_each(?))`, [
          JSON.stringify(missing),
        ])
        .map((r) => r.id),
    )
    for (const dst of missing) {
      if (!present.has(dst)) continue // dangling token; leave it as text
      this.db.exec(
        `INSERT INTO edges (id, src, dst, type, sort_key, created_at) VALUES (?, ?, ?, 'link', NULL, ?)`,
        [this.#uuid(), id, dst, this.#now()],
      )
    }
  }

  /** The node and all its descendants (live and deleted). */
  #subtreeIds(id: string): string[] {
    return this.db
      .all<{ id: string }>(
        `WITH RECURSIVE sub(id) AS (
           SELECT ?
           UNION
           SELECT e.dst FROM edges e JOIN sub ON e.src = sub.id WHERE e.type = 'child'
         ) SELECT id FROM sub`,
        [id],
      )
      .map((r) => r.id)
  }

  #isAncestorOrSelf(ancestor: string, id: string): boolean {
    return this.#subtreeIds(ancestor).includes(id)
  }

  #rootKeyAfterLast(): string {
    const last = () => this.db.get<{ k: string | null }>(`SELECT max(sort_key) AS k FROM nodes WHERE sort_key IS NOT NULL`)?.k ?? null
    try {
      return generateKeyBetween(last(), null)
    } catch {
      this.#rekeyRoots()
      return generateKeyBetween(last(), null)
    }
  }

  /**
   * Labels for nodes: text with nested tokens replaced by the target's label,
   * up to MAX_LABEL_DEPTH levels. Loads whatever nodes it needs.
   */
  #rawMany(ids: string[]): Map<string, RawNode> {
    const out = new Map<string, RawNode>()
    if (ids.length === 0) return out
    const rows = this.db.all<RawNode>(
      `SELECT ${NODE_COLS} FROM nodes WHERE id IN (SELECT value FROM json_each(?))`,
      [JSON.stringify(ids)],
    )
    for (const r of rows) out.set(r.id, r)
    return out
  }

  #labelResolver(seed: Map<string, RawNode> = new Map()) {
    const rows = seed
    const memo = new Map<string, string>()
    const ensure = (ids: string[]) => {
      let pending = ids.filter((i) => !rows.has(i))
      for (let depth = 0; depth <= MAX_LABEL_DEPTH && pending.length; depth++) {
        const got = this.#rawMany(pending)
        for (const [k, v] of got) rows.set(k, v)
        const next = new Set<string>()
        for (const id of pending) {
          const r = got.get(id)
          if (!r) continue
          for (const t of parseTokens(r.text)) if (!rows.has(t)) next.add(t)
        }
        pending = [...next]
      }
    }
    const label = (id: string, stack: string[] = []): string | undefined => {
      const cached = memo.get(id)
      if (cached !== undefined) return cached
      const r = rows.get(id)
      if (!r) return undefined
      if (stack.includes(id) || stack.length > MAX_LABEL_DEPTH) return '…'
      const l = cleanLabel(labelize(r.text, (t) => label(t, [...stack, id])))
      if (stack.length === 0) memo.set(id, l)
      return l
    }
    return { rows, ensure, label }
  }

  // --------------------------------------------------------------- creating

  /** Create a parentless node (pad, place, person, or a free-floating item). */
  createNode(kind: Kind, text = '', id?: string): string {
    return this.db.tx(() => this.#insertNode(kind, text, kind === 'pad' ? this.#rootKeyAfterLast() : null, id))
  }

  createPad(text = '', id?: string): string {
    return this.createNode('pad', text, id)
  }

  /**
   * Create a new child of parentId. afterSiblingId: undefined → append at the
   * end, null → insert first, an id → insert right after that sibling.
   */
  createChild(parentId: string, afterSiblingId?: string | null, init: NodeInit = {}): string {
    return this.db.tx(() => {
      this.#requireLive(parentId)
      const pos: Position = afterSiblingId === undefined ? 'last' : afterSiblingId === null ? 'first' : { after: afterSiblingId }
      const key = this.#keyAt(parentId, pos)
      const id = this.#insertNode(init.kind ?? 'item', init.text ?? '', null, init.id)
      this.#insertChildEdge(parentId, id, key)
      return id
    })
  }

  /** Create a new sibling directly before (or after) an existing node. */
  createSibling(siblingId: string, where: 'before' | 'after', init: NodeInit = {}): string {
    return this.db.tx(() => {
      const pe = this.#parentEdge(siblingId)
      if (!pe) throw new StoreError('Root nodes have no siblings', 'no_parent')
      this.#requireLive(pe.src)
      const key = this.#keyAt(pe.src, where === 'before' ? { before: siblingId } : { after: siblingId })
      const id = this.#insertNode(init.kind ?? 'item', init.text ?? '', null, init.id)
      this.#insertChildEdge(pe.src, id, key)
      return id
    })
  }

  /**
   * Insert several new nodes in order, in one transaction: after an existing
   * sibling, or as the first/last children of a parent. Returns their ids.
   */
  insertMany(
    anchor: { after: string } | { parent: string; position: 'first' | 'last' },
    items: NodeInit[],
  ): string[] {
    return this.db.tx(() => {
      const ids: string[] = []
      for (const init of items) {
        const prev = ids[ids.length - 1]
        let id: string
        if (prev) id = this.createSibling(prev, 'after', init)
        else if ('after' in anchor) id = this.createSibling(anchor.after, 'after', init)
        else id = this.createChild(anchor.parent, anchor.position === 'first' ? null : undefined, init)
        ids.push(id)
      }
      return ids
    })
  }

  /**
   * Split an item at the caret: it keeps `before` (and its children), and a new
   * sibling right after it gets `after`.
   */
  splitNode(id: string, before: string, after: string, newId?: string): string {
    return this.db.tx(() => {
      this.updateText(id, before)
      return this.createSibling(id, 'after', { text: after, id: newId })
    })
  }

  /**
   * Backspace at the start of an item: append its text to `targetId` (the row
   * above it) and delete it. Refused if it has live children or backlinks, so
   * nothing is silently orphaned.
   */
  mergeInto(id: string, targetId: string): boolean {
    return this.db.tx(() => {
      const n = this.#requireLive(id)
      const target = this.#requireLive(targetId)
      if (this.#liveChildIds(id).length > 0) return false
      const incoming = this.db.get<{ c: number }>(
        `SELECT count(*) AS c FROM edges e JOIN nodes s ON s.id = e.src
         WHERE e.dst = ? AND e.type = 'link' AND s.deleted_at IS NULL`,
        [id],
      )
      if ((incoming?.c ?? 0) > 0) return false
      this.updateText(targetId, target.text + n.text)
      this.deleteSubtree(id)
      return true
    })
  }

  // ---------------------------------------------------------------- editing

  /** Save text and reconcile outgoing link edges, in one transaction. */
  updateText(id: string, text: string): void {
    this.db.tx(() => {
      const n = this.#requireLive(id)
      if (n.text !== text) {
        this.db.exec('UPDATE nodes SET text = ?, updated_at = ? WHERE id = ?', [text, this.#now(), id])
      }
      this.#reconcileLinks(id, text)
    })
  }

  setDone(id: string, done: boolean): void {
    this.#requireLive(id)
    this.db.exec('UPDATE nodes SET done = ?, updated_at = ? WHERE id = ?', [done ? 1 : 0, this.#now(), id])
  }

  setCollapsed(id: string, collapsed: boolean): void {
    this.#requireLive(id)
    this.db.exec('UPDATE nodes SET collapsed = ? WHERE id = ?', [collapsed ? 1 : 0, id])
  }

  setKind(id: string, kind: Kind): void {
    if (!KINDS.includes(kind)) throw new StoreError(`Unknown kind ${kind}`, 'bad_kind')
    this.db.tx(() => {
      const n = this.#requireLive(id)
      if (n.kind === kind) return
      const hasParent = !!this.#parentEdge(id)
      if (kind === 'pad' && hasParent) throw new StoreError('A pad cannot have a parent', 'pad_parent')
      const sortKey = kind === 'pad' ? (n.sort_key ?? this.#rootKeyAfterLast()) : n.sort_key
      this.db.exec('UPDATE nodes SET kind = ?, sort_key = ?, updated_at = ? WHERE id = ?', [
        kind,
        sortKey,
        this.#now(),
        id,
      ])
    })
  }

  /** Soft-delete a node and its live descendants with one shared timestamp. */
  deleteSubtree(id: string): { deletedAt: number; count: number } {
    return this.db.tx(() => {
      this.#requireLive(id)
      const t = this.#now()
      const ids = this.#subtreeIds(id)
      this.db.exec(
        `UPDATE nodes SET deleted_at = ? WHERE deleted_at IS NULL AND id IN (SELECT value FROM json_each(?))`,
        [t, JSON.stringify(ids)],
      )
      const count = this.db.get<{ c: number }>('SELECT changes() AS c')?.c ?? 0
      return { deletedAt: t, count }
    })
  }

  /**
   * Undo deleteSubtree: revive nodes in the subtree deleted in the same batch.
   * If the node's parent is deleted too, that parent's batch is restored first
   * so the node doesn't come back invisible.
   */
  restoreSubtree(id: string): number {
    return this.db.tx(() => {
      const n = this.#raw(id)
      if (!n) throw new StoreError(`No node ${id}`, 'not_found')
      if (n.deleted_at === null) return 0
      let restored = 0
      const pe = this.#parentEdge(id)
      const parent = pe ? this.#raw(pe.src) : undefined
      if (parent && parent.deleted_at !== null) restored += this.restoreSubtree(parent.id)
      if (this.#raw(id)!.deleted_at === null) return restored
      const ids = this.#subtreeIds(id)
      this.db.exec(
        `UPDATE nodes SET deleted_at = NULL WHERE deleted_at = ? AND id IN (SELECT value FROM json_each(?))`,
        [n.deleted_at, JSON.stringify(ids)],
      )
      return restored + (this.db.get<{ c: number }>('SELECT changes() AS c')?.c ?? 0)
    })
  }

  // ------------------------------------------------------- tree operations

  /** Make the node the last child of its previous sibling. No-op for a first child. */
  indent(id: string): boolean {
    return this.db.tx(() => {
      this.#requireLive(id)
      const pe = this.#parentEdge(id)
      if (!pe) return false
      const sibs = this.#liveChildIds(pe.src)
      const i = sibs.indexOf(id)
      if (i <= 0) return false
      const newParent = sibs[i - 1]
      const key = this.#keyAt(newParent, 'last')
      this.db.exec('UPDATE edges SET src = ?, sort_key = ? WHERE id = ?', [newParent, key, pe.id])
      // Keep the moved node visible.
      this.db.exec('UPDATE nodes SET collapsed = 0 WHERE id = ? AND collapsed = 1', [newParent])
      return true
    })
  }

  /** Make the node the next sibling of its parent. No-op for a top-level item. */
  outdent(id: string): boolean {
    return this.db.tx(() => {
      this.#requireLive(id)
      const pe = this.#parentEdge(id)
      if (!pe) return false
      const ge = this.#parentEdge(pe.src)
      if (!ge) return false // parent is a root (pad): already top-level
      const key = this.#keyAt(ge.src, { after: pe.src }, id)
      this.db.exec('UPDATE edges SET src = ?, sort_key = ? WHERE id = ?', [ge.src, key, pe.id])
      return true
    })
  }

  /** Swap with the previous live sibling. No-op for a first child. */
  moveUp(id: string): boolean {
    return this.db.tx(() => {
      this.#requireLive(id)
      const pe = this.#parentEdge(id)
      if (!pe) return false
      const sibs = this.#liveChildIds(pe.src)
      const i = sibs.indexOf(id)
      if (i <= 0) return false
      const key = this.#keyAt(pe.src, { before: sibs[i - 1] }, id)
      this.db.exec('UPDATE edges SET sort_key = ? WHERE id = ?', [key, pe.id])
      return true
    })
  }

  /** Swap with the next live sibling. No-op for a last child. */
  moveDown(id: string): boolean {
    return this.db.tx(() => {
      this.#requireLive(id)
      const pe = this.#parentEdge(id)
      if (!pe) return false
      const sibs = this.#liveChildIds(pe.src)
      const i = sibs.indexOf(id)
      if (i < 0 || i === sibs.length - 1) return false
      const key = this.#keyAt(pe.src, { after: sibs[i + 1] }, id)
      this.db.exec('UPDATE edges SET sort_key = ? WHERE id = ?', [key, pe.id])
      return true
    })
  }

  /**
   * Move a node (with its subtree) under a new parent. afterSiblingId:
   * undefined → last, null → first. Rejects moving a node under itself or one
   * of its descendants.
   */
  moveSubtree(id: string, newParentId: string, afterSiblingId?: string | null): boolean {
    return this.db.tx(() => {
      const n = this.#requireLive(id)
      this.#requireLive(newParentId)
      if (n.kind === 'pad') throw new StoreError('Pads cannot be moved under another node', 'pad_parent')
      if (this.#isAncestorOrSelf(id, newParentId)) {
        throw new StoreError('Cannot move a node under itself or its descendant', 'cycle')
      }
      if (afterSiblingId === id) return false
      const pos: Position = afterSiblingId === undefined ? 'last' : afterSiblingId === null ? 'first' : { after: afterSiblingId }
      const key = this.#keyAt(newParentId, pos, id)
      const pe = this.#parentEdge(id)
      if (pe) {
        this.db.exec('UPDATE edges SET src = ?, sort_key = ? WHERE id = ?', [newParentId, key, pe.id])
      } else {
        this.#insertChildEdge(newParentId, id, key)
        this.db.exec('UPDATE nodes SET sort_key = NULL WHERE id = ?', [id])
      }
      return true
    })
  }

  /** Reorder pads: put padId right after afterPadId (null → first). */
  reorderPad(padId: string, afterPadId: string | null, retried = false): boolean {
    return this.db.tx(() => {
      const n = this.#requireLive(padId)
      if (n.kind !== 'pad') throw new StoreError('Not a pad', 'not_pad')
      const roots = this.db
        .all<{ id: string; sort_key: string | null }>(
          `SELECT id, sort_key FROM nodes WHERE sort_key IS NOT NULL AND id != ? ORDER BY sort_key, id`,
          [padId],
        )
      let lo: string | null = null
      let hi: string | null = roots[0]?.sort_key ?? null
      if (afterPadId !== null) {
        const i = roots.findIndex((r) => r.id === afterPadId)
        if (i < 0) throw new StoreError('Unknown pad', 'not_found')
        lo = roots[i].sort_key
        hi = roots[i + 1]?.sort_key ?? null
      }
      let key: string | null = null
      if (lo === null || hi === null || lo < hi) {
        try {
          key = generateKeyBetween(lo, hi)
        } catch {
          // Malformed key from an import; re-key below.
        }
      }
      if (key === null) {
        if (retried) throw new StoreError('Could not compute a sort key', 'sort_key')
        this.#rekeyRoots()
        return this.reorderPad(padId, afterPadId, true)
      }
      this.db.exec('UPDATE nodes SET sort_key = ? WHERE id = ?', [key, padId])
      return true
    })
  }

  /** Give every root node with a sort key a fresh, valid one, keeping order. */
  #rekeyRoots(): void {
    const roots = this.db.all<{ id: string }>(`SELECT id FROM nodes WHERE sort_key IS NOT NULL ORDER BY sort_key, id`)
    const keys = generateNKeysBetween(null, null, roots.length)
    roots.forEach((r, i) => this.db.exec('UPDATE nodes SET sort_key = ? WHERE id = ?', [keys[i], r.id]))
  }

  /** The pad that new items created from the link picker are filed under. */
  inboxId(): string {
    return this.db.tx(() => {
      const row = this.db.get<{ value: string }>(`SELECT value FROM meta WHERE key = 'inbox_id'`)
      const existing = row ? this.#raw(row.value) : undefined
      if (existing && existing.deleted_at === null) return existing.id
      const id = this.createPad('Inbox')
      this.db.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('inbox_id', ?)`, [id])
      return id
    })
  }

  createInInbox(init: NodeInit = {}): string {
    return this.db.tx(() => this.createChild(this.inboxId(), undefined, init))
  }

  /** On a brand-new database, create a short welcome pad. Returns its id, or null. */
  seedIfEmpty(): string | null {
    return this.db.tx(() => {
      const seeded = this.db.get(`SELECT value FROM meta WHERE key = 'seeded'`)
      const any = this.db.get(`SELECT id FROM nodes LIMIT 1`)
      if (seeded || any) return null
      this.db.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('seeded', '1')`)
      const pad = this.createPad('Welcome')
      const store = this.createNode('place', 'Hardware store')
      const add = (parent: string, text: string) => this.createChild(parent, undefined, { text })
      add(pad, 'Tap any line to edit it. Enter starts a new line.')
      const tb = add(pad, 'The bar above the keyboard indents, outdents and moves lines')
      add(tb, 'Like this nested line')
      const proj = add(pad, 'Fix the sprinkler')
      add(proj, `Buy 3/4-inch PVC elbows at [[${store}]]`)
      add(proj, `Pick up teflon tape at [[${store}]]`)
      add(pad, 'Type @ to link to any item, place or person. Tap a link to open it.')
      add(pad, 'Tap a bullet to open that item and see what links to it')
      add(pad, 'Settings → Export saves a backup of everything')
      return pad
    })
  }

  // ---------------------------------------------------------------- reading

  getNode(id: string): NodeInfo | null {
    const r = this.#raw(id)
    return r ? toInfo(r) : null
  }

  getChildren(id: string): NodeInfo[] {
    const ids = this.#liveChildIds(id)
    const rows = this.#rawMany(ids)
    return ids.map((i) => toInfo(rows.get(i)!))
  }

  /** The node and its live descendants as a nested tree. */
  getTree(rootId: string): TreeNode {
    const rows = this.db.all<RawNode & { parent: string | null; edge_key: string | null; edge_id: string | null }>(
      `WITH RECURSIVE sub(id) AS (
         SELECT ?
         UNION
         SELECT e.dst FROM edges e JOIN sub ON e.src = sub.id JOIN nodes c ON c.id = e.dst
         WHERE e.type = 'child' AND c.deleted_at IS NULL
       )
       SELECT n.id, n.kind, n.text, n.done, n.collapsed, n.created_at, n.updated_at, n.deleted_at, n.sort_key,
              pe.src AS parent, pe.sort_key AS edge_key, pe.id AS edge_id
       FROM sub JOIN nodes n ON n.id = sub.id
       LEFT JOIN edges pe ON pe.dst = n.id AND pe.type = 'child'`,
      [rootId],
    )
    const byId = new Map<string, TreeNode & { _key: string; _edge: string }>()
    for (const r of rows) {
      byId.set(r.id, {
        id: r.id,
        kind: r.kind,
        text: r.text,
        done: !!r.done,
        collapsed: !!r.collapsed,
        children: [],
        _key: r.edge_key ?? '',
        _edge: r.edge_id ?? '',
      })
    }
    const root = byId.get(rootId)
    if (!root) throw new StoreError(`No node ${rootId}`, 'not_found')
    for (const r of rows) {
      if (r.id === rootId || !r.parent) continue
      byId.get(r.parent)?.children.push(byId.get(r.id)!)
    }
    const strip = (t: TreeNode & { _key?: string; _edge?: string }): TreeNode => {
      const kids = (t.children as (TreeNode & { _key: string; _edge: string })[]).sort((a, b) =>
        compareKeys({ sort_key: a._key, edge_id: a._edge }, { sort_key: b._key, edge_id: b._edge }),
      )
      return { id: t.id, kind: t.kind, text: t.text, done: t.done, collapsed: t.collapsed, children: kids.map(strip) }
    }
    return strip(root)
  }

  /** Ancestors of a node, root first, not including the node. */
  getAncestors(id: string): Crumb[] {
    const rows = this.db.all<{ id: string; kind: Kind; text: string; depth: number }>(
      `WITH RECURSIVE up(id, depth) AS (
         SELECT src, 1 FROM edges WHERE dst = ? AND type = 'child'
         UNION
         SELECT e.src, up.depth + 1 FROM edges e JOIN up ON e.dst = up.id
         WHERE e.type = 'child' AND up.depth < 500
       )
       SELECT n.id, n.kind, n.text, up.depth FROM up JOIN nodes n ON n.id = up.id ORDER BY up.depth DESC`,
      [id],
    )
    const res = this.#labelResolver()
    res.ensure(rows.flatMap((r) => parseTokens(r.text)))
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      label: cleanLabel(labelize(r.text, (t) => res.label(t))),
    }))
  }

  /** Chip data for the given ids (missing ids get exists: false). */
  getRefs(ids: string[]): Record<string, RefInfo> {
    const res = this.#labelResolver()
    res.ensure(ids)
    const out: Record<string, RefInfo> = {}
    for (const id of ids) {
      const r = res.rows.get(id)
      out[id] = r
        ? { id, kind: r.kind, label: res.label(id) ?? '', done: !!r.done, deleted: r.deleted_at !== null, exists: true }
        : { id, kind: 'item', label: 'missing', done: false, deleted: true, exists: false }
    }
    return out
  }

  getLabel(id: string): string {
    return this.getRefs([id])[id].label
  }

  getBacklinks(id: string): Backlink[] {
    const rows = this.db.all<RawNode>(
      `SELECT ${NODE_COLS.split(', ').map((c) => 's.' + c).join(', ')}
       FROM edges e JOIN nodes s ON s.id = e.src
       WHERE e.dst = ? AND e.type = 'link' AND s.deleted_at IS NULL`,
      [id],
    )
    const out = rows.map((r) => ({ source: toInfo(r), crumbs: this.getAncestors(r.id) }))
    const pathOf = (b: Backlink) => b.crumbs.map((c) => c.label).join('\u0000').toLowerCase()
    out.sort((a, b) => {
      if (a.source.done !== b.source.done) return a.source.done ? 1 : -1
      const pa = pathOf(a)
      const pb = pathOf(b)
      if (pa !== pb) return pa < pb ? -1 : 1
      return b.source.updated_at - a.source.updated_at
    })
    return out
  }

  /** Everything the node screen needs in one round trip. */
  getNodeView(id: string): NodeViewData {
    const raw = this.#raw(id)
    if (!raw) throw new StoreError(`No node ${id}`, 'not_found')
    const tree = this.getTree(id)
    const backlinks = this.getBacklinks(id)
    const outgoingIds = this.db
      .all<{ dst: string }>(`SELECT dst FROM edges WHERE src = ? AND type = 'link' ORDER BY created_at, id`, [id])
      .map((r) => r.dst)
    const tokenIds = new Set<string>(outgoingIds)
    const walk = (t: TreeNode) => {
      for (const tok of parseTokens(t.text)) tokenIds.add(tok)
      t.children.forEach(walk)
    }
    walk(tree)
    for (const b of backlinks) for (const tok of parseTokens(b.source.text)) tokenIds.add(tok)
    const refs = this.getRefs([...tokenIds])
    // Order outgoing links by their position in the text.
    const order = parseTokens(raw.text)
    outgoingIds.sort((a, b) => order.indexOf(a) - order.indexOf(b))
    return {
      node: toInfo(raw),
      ancestors: this.getAncestors(id),
      tree,
      refs,
      outgoing: outgoingIds.map((o) => refs[o]),
      backlinks,
    }
  }

  listPads(): PadSummary[] {
    const pads = this.db.all<RawNode>(
      `SELECT ${NODE_COLS} FROM nodes WHERE kind = 'pad' AND deleted_at IS NULL ORDER BY sort_key, id`,
    )
    const counts = this.db.all<{ pad: string; items: number; open: number }>(
      `WITH RECURSIVE d(pad, id) AS (
         SELECT id, id FROM nodes WHERE kind = 'pad' AND deleted_at IS NULL
         UNION ALL
         SELECT d.pad, e.dst FROM edges e JOIN d ON e.src = d.id JOIN nodes c ON c.id = e.dst
         WHERE e.type = 'child' AND c.deleted_at IS NULL
       )
       SELECT d.pad AS pad, count(*) - 1 AS items,
              sum(CASE WHEN n.done = 0 AND n.id != d.pad THEN 1 ELSE 0 END) AS open
       FROM d JOIN nodes n ON n.id = d.id GROUP BY d.pad`,
    )
    const byPad = new Map(counts.map((c) => [c.pad, c]))
    const res = this.#labelResolver(new Map(pads.map((p) => [p.id, p])))
    res.ensure(pads.flatMap((p) => parseTokens(p.text)))
    return pads.map((p) => ({
      id: p.id,
      text: p.text,
      label: res.label(p.id) ?? '',
      itemCount: byPad.get(p.id)?.items ?? 0,
      openCount: byPad.get(p.id)?.open ?? 0,
      updated_at: p.updated_at,
    }))
  }

  /** Index screen for places / people: every live node of that kind. */
  listByKind(kind: Kind): IndexEntry[] {
    const rows = this.db.all<RawNode & { total: number; open: number }>(
      `SELECT ${NODE_COLS.split(', ').map((c) => 'n.' + c).join(', ')},
         (SELECT count(*) FROM edges e JOIN nodes s ON s.id = e.src
            WHERE e.dst = n.id AND e.type = 'link' AND s.deleted_at IS NULL) AS total,
         (SELECT count(*) FROM edges e JOIN nodes s ON s.id = e.src
            WHERE e.dst = n.id AND e.type = 'link' AND s.deleted_at IS NULL AND s.done = 0) AS open
       FROM nodes n WHERE n.kind = ? AND n.deleted_at IS NULL`,
      [kind],
    )
    const res = this.#labelResolver(new Map(rows.map((r) => [r.id, r])))
    res.ensure(rows.flatMap((r) => parseTokens(r.text)))
    return rows
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        text: r.text,
        label: res.label(r.id) ?? '',
        openBacklinks: r.open,
        totalBacklinks: r.total,
        updated_at: r.updated_at,
      }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }))
  }

  /** Fuzzy search over live nodes. An empty query returns recently edited nodes. */
  search(query: string, opts: SearchOptions = {}): SearchResult[] {
    const limit = opts.limit ?? 20
    const exclude = new Set(opts.excludeIds ?? [])
    const all = this.db.all<RawNode>(`SELECT ${NODE_COLS} FROM nodes`)
    const rows = new Map(all.map((r) => [r.id, r]))
    const res = this.#labelResolver(rows)
    const parentOf = new Map(
      this.db.all<{ src: string; dst: string }>(`SELECT src, dst FROM edges WHERE type = 'child'`).map((e) => [e.dst, e.src]),
    )
    const kinds = opts.kinds ? new Set(opts.kinds) : null
    const q = query.trim()
    const scored: { r: RawNode; label: string; score: number }[] = []
    for (const r of all) {
      if (r.deleted_at !== null || exclude.has(r.id)) continue
      if (kinds && !kinds.has(r.kind)) continue
      const label = res.label(r.id) ?? ''
      if (!label && q) continue
      let score: number
      if (q) {
        const s = fuzzyScore(q, label)
        if (s === null) continue
        score = s + (r.kind === 'place' || r.kind === 'person' ? 8 : r.kind === 'pad' ? 4 : 0) - (r.done ? 10 : 0)
      } else {
        if (!label) continue
        score = r.updated_at / 1e12 + (r.kind === 'item' ? 0 : 1)
      }
      scored.push({ r, label, score })
    }
    scored.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
    return scored.slice(0, limit).map(({ r, label, score }) => {
      const crumbs: string[] = []
      let p = parentOf.get(r.id)
      for (let guard = 0; p && guard < 100; guard++) {
        crumbs.unshift(res.label(p) ?? '')
        p = parentOf.get(p)
      }
      const context = crumbs.length > 3 ? [crumbs[0], '…', crumbs[crumbs.length - 1]].join(' › ') : crumbs.join(' › ')
      return { id: r.id, kind: r.kind, label, done: !!r.done, context, score }
    })
  }

  /** Nodes within `hops` of a node over child and link edges, both directions. */
  getNeighborhood(id: string, hops = 2, maxNodes = 150): Neighborhood {
    const center = this.#raw(id)
    if (!center) throw new StoreError(`No node ${id}`, 'not_found')
    const hopOf = new Map<string, number>([[id, 0]])
    let frontier = [id]
    let truncated = false
    for (let h = 1; h <= hops && frontier.length && !truncated; h++) {
      const rows = this.db.all<{ a: string; b: string }>(
        `SELECT e.src AS a, e.dst AS b FROM edges e
           JOIN nodes s ON s.id = e.src JOIN nodes d ON d.id = e.dst
         WHERE (e.src IN (SELECT value FROM json_each(?1)) OR e.dst IN (SELECT value FROM json_each(?1)))
           AND e.type IN ('child', 'link') AND s.deleted_at IS NULL AND d.deleted_at IS NULL`,
        [JSON.stringify(frontier)],
      )
      const next: string[] = []
      for (const { a, b } of rows) {
        for (const n of [a, b]) {
          if (hopOf.has(n)) continue
          if (hopOf.size >= maxNodes) {
            truncated = true
            continue
          }
          hopOf.set(n, h)
          next.push(n)
        }
      }
      frontier = next
    }
    const ids = [...hopOf.keys()]
    const edges = this.db.all<GraphEdge>(
      `SELECT src, dst, type FROM edges
       WHERE type IN ('child', 'link')
         AND src IN (SELECT value FROM json_each(?1)) AND dst IN (SELECT value FROM json_each(?1))`,
      [JSON.stringify(ids)],
    )
    const refs = this.getRefs(ids)
    const nodes: GraphNode[] = ids.map((n) => ({
      id: n,
      kind: refs[n].kind,
      label: refs[n].label,
      done: refs[n].done,
      hop: hopOf.get(n)!,
    }))
    return { center: id, nodes, edges, truncated }
  }

  /** Top-level entries of the trash: deleted nodes whose parent is live (or who have none). */
  listDeleted(): DeletedEntry[] {
    const rows = this.db.all<RawNode>(
      `SELECT ${NODE_COLS.split(', ').map((c) => 'n.' + c).join(', ')} FROM nodes n
       LEFT JOIN edges pe ON pe.dst = n.id AND pe.type = 'child'
       LEFT JOIN nodes p ON p.id = pe.src
       WHERE n.deleted_at IS NOT NULL
         AND (p.id IS NULL OR p.deleted_at IS NULL)
       ORDER BY n.deleted_at DESC
       LIMIT 200`,
    )
    return rows.map((r) => {
      const ids = this.#subtreeIds(r.id)
      const c = this.db.get<{ c: number }>(
        `SELECT count(*) AS c FROM nodes WHERE deleted_at = ? AND id IN (SELECT value FROM json_each(?))`,
        [r.deleted_at, JSON.stringify(ids)],
      )
      return {
        id: r.id,
        kind: r.kind,
        label: this.getLabel(r.id),
        deleted_at: r.deleted_at!,
        count: c?.c ?? 1,
        crumbs: this.getAncestors(r.id),
      }
    })
  }

  /** Permanently remove soft-deleted nodes (and every edge touching them). */
  purgeDeleted(): number {
    return this.db.tx(() => {
      const dead = `SELECT id FROM nodes WHERE deleted_at IS NOT NULL`
      this.db.exec(`DELETE FROM edges WHERE src IN (${dead}) OR dst IN (${dead})`)
      this.db.exec(`DELETE FROM nodes WHERE deleted_at IS NOT NULL`)
      return this.db.get<{ c: number }>('SELECT changes() AS c')?.c ?? 0
    })
  }

  info(): { schemaVersion: number; nodeCount: number; edgeCount: number } {
    return {
      schemaVersion: schemaVersion(this.db),
      nodeCount: this.db.get<{ c: number }>('SELECT count(*) AS c FROM nodes WHERE deleted_at IS NULL')?.c ?? 0,
      edgeCount: this.db.get<{ c: number }>('SELECT count(*) AS c FROM edges')?.c ?? 0,
    }
  }

  // --------------------------------------------------------- export/import

  exportAll(): ExportFile {
    return {
      app: 'graph-scratchpad',
      format: 1,
      schema_version: schemaVersion(this.db),
      exported_at: this.#now(),
      nodes: this.db.all<RawNode>(`SELECT ${NODE_COLS} FROM nodes ORDER BY created_at, id`),
      edges: this.db.all<RawEdge>(`SELECT id, src, dst, type, sort_key, created_at FROM edges ORDER BY created_at, id`),
    }
  }

  /** Replace the whole database with the contents of an export file. */
  importAll(data: unknown): ImportResult {
    const file = validateExport(data)
    return this.db.tx(() => {
      this.db.exec('DELETE FROM edges')
      this.db.exec('DELETE FROM nodes')
      for (const n of file.nodes) {
        this.db.exec(
          `INSERT INTO nodes (${NODE_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [n.id, n.kind, n.text, n.done, n.collapsed, n.created_at, n.updated_at, n.deleted_at, n.sort_key],
        )
      }
      for (const e of file.edges) {
        this.db.exec(`INSERT INTO edges (id, src, dst, type, sort_key, created_at) VALUES (?, ?, ?, ?, ?, ?)`, [
          e.id,
          e.src,
          e.dst,
          e.type,
          e.sort_key,
          e.created_at,
        ])
      }
      // Pads from older exports may lack a root sort key.
      for (const p of this.db.all<{ id: string }>(
        `SELECT id FROM nodes WHERE kind = 'pad' AND sort_key IS NULL ORDER BY created_at, id`,
      )) {
        this.db.exec('UPDATE nodes SET sort_key = ? WHERE id = ?', [this.#rootKeyAfterLast(), p.id])
      }
      return { nodes: file.nodes.length, edges: file.edges.length }
    })
  }
}

// -------------------------------------------------------------- validation

function fail(msg: string): never {
  throw new StoreError(`Invalid export file: ${msg}`, 'bad_import')
}

export function validateExport(data: unknown): ExportFile {
  if (!data || typeof data !== 'object') fail('not an object')
  const d = data as Record<string, unknown>
  if (d.app !== 'graph-scratchpad') fail('not a graph-scratchpad export')
  if (d.format !== 1) fail(`unsupported format ${String(d.format)}`)
  if (typeof d.schema_version === 'number' && d.schema_version > LATEST_SCHEMA_VERSION) {
    fail(`it comes from a newer version of the app (schema ${d.schema_version})`)
  }
  if (!Array.isArray(d.nodes) || !Array.isArray(d.edges)) fail('missing nodes or edges')
  const isStr = (v: unknown): v is string => typeof v === 'string'
  const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

  const nodes: RawNode[] = []
  const ids = new Set<string>()
  for (const [i, raw] of (d.nodes as unknown[]).entries()) {
    const n = raw as Record<string, unknown>
    if (!n || !isStr(n.id) || !n.id) fail(`node ${i} has no id`)
    if (ids.has(n.id)) fail(`duplicate node id ${n.id}`)
    ids.add(n.id)
    const kind = KINDS.includes(n.kind as Kind) ? (n.kind as Kind) : 'item'
    const created = isNum(n.created_at) ? n.created_at : 0
    nodes.push({
      id: n.id,
      kind,
      text: isStr(n.text) ? n.text : '',
      done: n.done ? 1 : 0,
      collapsed: n.collapsed ? 1 : 0,
      created_at: created,
      updated_at: isNum(n.updated_at) ? n.updated_at : created,
      deleted_at: isNum(n.deleted_at) ? n.deleted_at : null,
      sort_key: isStr(n.sort_key) ? n.sort_key : null,
    })
  }

  const edges: RawEdge[] = []
  const edgeIds = new Set<string>()
  const parentOf = new Map<string, string>()
  for (const [i, raw] of (d.edges as unknown[]).entries()) {
    const e = raw as Record<string, unknown>
    if (!e || !isStr(e.id) || !isStr(e.src) || !isStr(e.dst) || !isStr(e.type)) fail(`edge ${i} is malformed`)
    if (edgeIds.has(e.id)) fail(`duplicate edge id ${e.id}`)
    edgeIds.add(e.id)
    if (!ids.has(e.src) || !ids.has(e.dst)) fail(`edge ${e.id} points at a missing node`)
    if (e.type === 'child') {
      if (parentOf.has(e.dst)) fail(`node ${e.dst} has two parents`)
      if (e.src === e.dst) fail(`node ${e.dst} is its own parent`)
      parentOf.set(e.dst, e.src)
    }
    edges.push({
      id: e.id,
      src: e.src,
      dst: e.dst,
      type: e.type,
      sort_key: isStr(e.sort_key) ? e.sort_key : null,
      created_at: isNum(e.created_at) ? e.created_at : 0,
    })
  }
  // No cycles in the tree.
  for (const start of parentOf.keys()) {
    const seen = new Set<string>([start])
    for (let p = parentOf.get(start); p; p = parentOf.get(p)) {
      if (seen.has(p)) fail(`the tree contains a cycle at ${p}`)
      seen.add(p)
    }
  }
  return {
    app: 'graph-scratchpad',
    format: 1,
    schema_version: isNum(d.schema_version) ? d.schema_version : LATEST_SCHEMA_VERSION,
    exported_at: isNum(d.exported_at) ? d.exported_at : 0,
    nodes,
    edges,
  }
}
