import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing'
import type { SqlDb } from './sql'
import { LATEST_SCHEMA_VERSION, migrate, schemaVersion } from './migrations'
import { labelize, makeToken, parseTokens, soleLink } from '../lib/tokens'
import { fuzzyScore } from '../lib/fuzzy'
import { PHRASES_VERSION, linkContexts } from '../lib/relations'
import { textHash } from '../lib/textHash'
import { Hlc, UNKNOWN_HLC, ZERO_HLC, hlcWall } from './hlc'
import {
  KINDS,
  NO_RELATION_ID,
  PEOPLE_ID,
  PLACES_ID,
  type CategoryInfo,
  type CategoryProps,
  type ContextEntry,
  type Backlink,
  type Crumb,
  type DeletedEntry,
  type Fact,
  type FactView,
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
  type BrowseRow,
  type RawEdge,
  type RawNode,
  type RefInfo,
  type RelationLink,
  type RelationsData,
  type SearchOptions,
  type SearchResult,
  type SyncChange,
  type SyncInfo,
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
  /** A to-do (checkbox) or a plain bullet. Default: like the neighbouring item (see #taskFor). */
  task?: boolean
  /** Start checked off (to-dos only), e.g. a pasted "[x] …" line. */
  done?: boolean
}

/** A new node with what goes inside it, e.g. a pasted outline. */
export interface OutlineInit extends NodeInit {
  /** Its children are a numbered list. */
  numbered?: boolean
  children?: OutlineInit[]
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Where to put a node among its siblings. */
type Position = { after: string } | { before: string } | 'first' | 'last'

interface SiblingRow {
  edge_id: string
  dst: string
  sort_key: string | null
}

const NODE_COLS = 'id, kind, text, done, collapsed, created_at, updated_at, deleted_at, sort_key, numbered, task, purged, category, props, facts'
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

/** The kind of context a node is: its category, or for older places and people, the built-in kind. */
function effectiveCategory(r: Pick<RawNode, 'kind' | 'category'>): string | null {
  if (r.kind === 'pad' || r.kind === 'relation' || r.kind === 'category') return null
  return r.category ?? (r.kind === 'place' ? PLACES_ID : r.kind === 'person' ? PEOPLE_ID : null)
}

function toInfo(r: RawNode): NodeInfo {
  return {
    category: effectiveCategory(r),
    id: r.id,
    kind: r.kind,
    text: r.text,
    done: !!r.done,
    collapsed: !!r.collapsed,
    created_at: r.created_at,
    updated_at: r.updated_at,
    deleted: r.deleted_at !== null,
    numbered: !!r.numbered,
    task: !!r.task,
  }
}

function cleanLabel(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** How phrases are compared: "Buy  At" is "buy at". */
const normPhrase = (s: string) => cleanLabel(s).toLowerCase()

/** Your relations, for resolving labels: phrase → relation id, and relation id → name. */
type Vocab = { byPhrase: Map<string, string>; names: Map<string, string> }

/**
 * Sibling order: by sort key, then by node id. (Two devices can pick the same
 * key for different nodes; the node id breaks the tie the same way on both.)
 */
function compareKeys(a: { sort_key: string | null; dst: string }, b: { sort_key: string | null; dst: string }) {
  const ak = a.sort_key ?? ''
  const bk = b.sort_key ?? ''
  if (ak < bk) return -1
  if (ak > bk) return 1
  return a.dst < b.dst ? -1 : a.dst > b.dst ? 1 : 0
}

/** Fields that sync, and how to clean a value received for each. */
const SYNC_COLUMNS: Record<string, (v: unknown) => string | number | null> = {
  kind: (v) => (KINDS.includes(v as Kind) ? (v as Kind) : 'item'),
  text: (v) => (typeof v === 'string' ? v : ''),
  done: (v) => (v ? 1 : 0),
  collapsed: (v) => (v ? 1 : 0),
  deleted_at: (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null),
  numbered: (v) => (v ? 1 : 0),
  task: (v) => (v ? 1 : 0),
  purged: (v) => (v ? 1 : 0),
  created_at: (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0),
  // Server-written link labels (see migration 7); kept as JSON text.
  rels: (v) => (v && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : null),
  // Kinds of context (migration 9).
  category: (v) => (typeof v === 'string' && UUID_RE.test(v) ? v : null),
  props: (v) => (v && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : null),
  // Facts about a node (migration 11).
  facts: (v) => (Array.isArray(v) && v.length ? JSON.stringify(v) : null),
  // Relations you chose for single links (migration 8).
  link_rels: (v) => (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length ? JSON.stringify(v) : null),
}
const SYNC_FIELDS = new Set([...Object.keys(SYNC_COLUMNS), 'pos'])

/**
 * The data layer. Every public method is synchronous and runs against a
 * SqlDb; the worker exposes them over postMessage (see api.ts). Methods that
 * change more than one row run in a single transaction.
 */
export class Store {
  readonly db: SqlDb
  #now: () => number
  #uuid: () => string
  #hlc: Hlc

  constructor(db: SqlDb, deps: StoreDeps = {}) {
    this.db = db
    this.#now = deps.now ?? (() => Date.now())
    this.#uuid = deps.uuid ?? (() => crypto.randomUUID())
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)')
    this.#hlc = new Hlc(this.#deviceId(), this.#now)
    // The sync triggers stamp every change with this (see migration 5).
    db.createFunction('hlc_now', () => this.#hlc.tick())
    migrate(db)
    // Never hand out a time earlier than one already recorded (the device's clock may have moved back).
    this.#hlc.observe(db.get<{ h: string | null }>('SELECT max(hlc) AS h FROM sync_clock')?.h)
    // Link phrases are derived from text: fill them in after an upgrade or a change in how they're guessed.
    if (this.#meta('link_phrases') !== PHRASES_VERSION) {
      db.tx(() => {
        for (const r of db.all<{ id: string; text: string }>(`SELECT id, text FROM nodes WHERE instr(text, '[[') > 0`)) {
          this.#reconcileLinks(r.id, r.text)
        }
        this.#setMeta('link_phrases', PHRASES_VERSION)
      })
    }
  }

  #meta(key: string): string | undefined {
    return this.db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key])?.value
  }

  #setMeta(key: string, value: string): void {
    this.db.exec('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [key, value])
  }

  #deviceId(): string {
    const existing = this.#meta('device_id')
    if (existing) return existing
    const id = this.#uuid().replace(/-/g, '').slice(0, 12)
    this.#setMeta('device_id', id)
    return id
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

  #insertNode(kind: Kind, text: string, sortKey: string | null = null, wantedId?: string, task = false, done = false): string {
    if (wantedId !== undefined) {
      if (!UUID_RE.test(wantedId)) throw new StoreError(`Bad id ${wantedId}`, 'bad_id')
      if (this.#raw(wantedId)) throw new StoreError(`Node ${wantedId} already exists`, 'exists')
    }
    if (!KINDS.includes(kind)) throw new StoreError(`Unknown kind ${kind}`, 'bad_kind')
    const id = wantedId ?? this.#uuid()
    const t = this.#now()
    // Only items can be to-dos, and only to-dos can be done.
    const isTask = kind === 'item' && task
    this.db.exec(
      `INSERT INTO nodes (id, kind, text, done, collapsed, created_at, updated_at, deleted_at, sort_key, numbered, task)
       VALUES (?, ?, ?, ?, 0, ?, ?, NULL, ?, 0, ?)`,
      [id, kind, text, isTask && done ? 1 : 0, t, t, sortKey, isTask ? 1 : 0],
    )
    if (text) this.#reconcileLinks(id, text)
    return id
  }

  /**
   * Whether a new item at this spot is a to-do: the same as the item next to
   * it, so a checklist continues as a checklist and notes as notes. With no
   * neighbouring item, a to-do, except under a place or person, where it's a note.
   */
  #taskFor(parentId: string, neighbourId: string | null): boolean {
    const near = neighbourId ? this.#raw(neighbourId) : undefined
    if (near?.kind === 'item') return near.task === 1
    const parent = this.#raw(parentId)
    return !(parent && (effectiveCategory(parent) || parent.kind === 'relation'))
  }

  #insertChildEdge(parentId: string, childId: string, key: string): void {
    this.db.exec(
      `INSERT INTO edges (id, src, dst, type, sort_key, created_at) VALUES (?, ?, ?, 'child', ?, ?)`,
      [this.#uuid(), parentId, childId, key, this.#now()],
    )
  }

  /**
   * Make the node's outgoing link edges match the [[uuid]] tokens in its text,
   * each with the relation its wording suggests.
   */
  #reconcileLinks(id: string, text: string): void {
    // A line that is only a link stands for what it links to (migration 10).
    const sole = soleLink(text)
    const ref = sole && sole !== id ? sole : null
    this.db.exec('UPDATE nodes SET ref = ? WHERE id = ? AND ref IS NOT ?', [ref, id, ref])
    // Facts are links too, from the node they're about, labelled with their relation.
    const factTo = new Map(this.#facts(id).filter((f) => f.to !== id).map((f) => [f.to, f.name]))
    const wanted = new Set([...parseTokens(text).filter((t) => t !== id), ...factTo.keys()])
    const contexts = wanted.size ? linkContexts(text) : new Map()
    // The server's label wins while it was read from this exact text; otherwise our own guess.
    const rels = wanted.size ? this.#rels(id) : {}
    const hash = wanted.size ? textHash(text) : ''
    const phraseOf = (dst: string) => {
      if (factTo.has(dst)) return factTo.get(dst)!
      const label = rels[dst]
      return label && label.h === hash ? label.r : (contexts.get(dst)?.phrase ?? null)
    }
    const existing = this.db.all<{ id: string; dst: string; phrase: string | null }>(
      `SELECT id, dst, phrase FROM edges WHERE src = ? AND type = 'link'`,
      [id],
    )
    const have = new Set<string>()
    for (const e of existing) {
      if (!wanted.has(e.dst) || have.has(e.dst)) {
        this.db.exec('DELETE FROM edges WHERE id = ?', [e.id])
      } else {
        have.add(e.dst)
        if (e.phrase !== phraseOf(e.dst)) this.db.exec('UPDATE edges SET phrase = ? WHERE id = ?', [phraseOf(e.dst), e.id])
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
        `INSERT INTO edges (id, src, dst, type, sort_key, created_at, phrase) VALUES (?, ?, ?, 'link', NULL, ?, ?)`,
        [this.#uuid(), id, dst, this.#now(), phraseOf(dst)],
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
      let task = init.task
      if (task === undefined) {
        const kids = afterSiblingId ? [] : this.#liveChildIds(parentId)
        const near = afterSiblingId ?? (afterSiblingId === null ? kids[0] : kids[kids.length - 1]) ?? null
        task = this.#taskFor(parentId, near)
      }
      const id = this.#insertNode(init.kind ?? 'item', init.text ?? '', null, init.id, task, init.done)
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
      const task = init.task ?? this.#taskFor(pe.src, siblingId)
      const id = this.#insertNode(init.kind ?? 'item', init.text ?? '', null, init.id, task, init.done)
      this.#insertChildEdge(pe.src, id, key)
      return id
    })
  }

  /**
   * Insert several new nodes in order, with what's inside them, in one
   * transaction: after an existing sibling, or as the first/last children of a
   * parent. Returns the ids of the top-level ones.
   */
  insertMany(
    anchor: { after: string } | { parent: string; position: 'first' | 'last' },
    items: OutlineInit[],
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
        if (init.numbered) this.setNumbered(id, true)
        if (init.children?.length) this.insertMany({ parent: id, position: 'last' }, init.children)
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

  /** Check an item off (or not). Checking off a plain bullet makes it a to-do. */
  setDone(id: string, done: boolean): void {
    const n = this.#requireLive(id)
    if (n.kind !== 'item') throw new StoreError('Only items can be checked off', 'not_item')
    this.db.exec('UPDATE nodes SET done = ?, task = CASE WHEN ? = 1 THEN 1 ELSE task END, updated_at = ? WHERE id = ?', [
      done ? 1 : 0,
      done ? 1 : 0,
      this.#now(),
      id,
    ])
  }

  /** Make an item a to-do (true) or a plain bullet (false). A bullet can't be done, so that unchecks it. */
  setTask(id: string, task: boolean): void {
    const n = this.#requireLive(id)
    if (n.kind !== 'item') {
      if (task) throw new StoreError('Only items can be to-dos', 'not_item')
      return
    }
    if (n.task === (task ? 1 : 0)) return
    this.db.exec('UPDATE nodes SET task = ?, done = CASE WHEN ? = 1 THEN done ELSE 0 END, updated_at = ? WHERE id = ?', [
      task ? 1 : 0,
      task ? 1 : 0,
      this.#now(),
      id,
    ])
  }

  /** setTask for every item directly inside a node. Returns how many changed. */
  setChildrenTask(parentId: string, task: boolean): number {
    return this.db.tx(() => {
      this.#requireLive(parentId)
      const t = task ? 1 : 0
      this.db.exec(
        `UPDATE nodes SET task = ?, done = CASE WHEN ? = 1 THEN done ELSE 0 END, updated_at = ?
         WHERE kind = 'item' AND task <> ? AND id IN (SELECT value FROM json_each(?))`,
        [t, t, this.#now(), t, JSON.stringify(this.#liveChildIds(parentId))],
      )
      return this.db.get<{ c: number }>('SELECT changes() AS c')?.c ?? 0
    })
  }

  /** Show this node's children as a numbered list (true) or bullets (false). */
  setNumbered(id: string, numbered: boolean): void {
    this.#requireLive(id)
    this.db.exec('UPDATE nodes SET numbered = ?, updated_at = ? WHERE id = ?', [numbered ? 1 : 0, this.#now(), id])
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
      // Only items are to-dos; anything else is never checked off.
      const keep = kind === 'item'
      this.db.exec('UPDATE nodes SET kind = ?, sort_key = ?, task = ?, done = ?, updated_at = ? WHERE id = ?', [
        kind,
        sortKey,
        keep ? n.task : 0,
        keep ? n.done : 0,
        this.#now(),
        id,
      ])
    })
  }

  /**
   * Turn a line in a list into a place or person. Places and people are
   * standalone nodes you link to, so this creates a new root node with the
   * line's text and replaces the line's text with a link to it. The line keeps
   * its position, children and done state. A node without a parent is simply
   * relabelled. Returns the id of the place/person.
   */
  convertToHub(id: string, kind: 'place' | 'person', newId?: string): string {
    return this.db.tx(() => {
      const n = this.#requireLive(id)
      if (n.kind === 'pad') throw new StoreError('A pad can’t become a place or person', 'pad_kind')
      if (!this.#parentEdge(id)) {
        this.setKind(id, kind)
        return id
      }
      const hub = this.#insertNode(kind, n.text, null, newId)
      this.updateText(id, makeToken(hub))
      return hub
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
      if (!n || n.purged) throw new StoreError(`No node ${id}`, 'not_found')
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

  /**
   * Bring back a line deleted with its subtree, but somewhere else (vim's p
   * after dd): the same node, so links to it keep working. False when it
   * isn't deleted (any more).
   */
  restoreTo(id: string, parentId: string, afterSiblingId: string | null): boolean {
    return this.db.tx(() => {
      const n = this.#raw(id)
      if (!n || n.purged || n.deleted_at === null) return false
      this.db.exec(
        `UPDATE nodes SET deleted_at = NULL WHERE deleted_at = ? AND id IN (SELECT value FROM json_each(?))`,
        [n.deleted_at, JSON.stringify(this.#subtreeIds(id))],
      )
      this.moveSubtree(id, parentId, afterSiblingId)
      return true
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

  /** Places and People, as migration 9 makes them (clock '0': the same on every device). */
  #ensureBuiltInCategories(): void {
    const builtIns: [string, string, CategoryProps][] = [
      [PLACES_ID, 'Places', { icon: 'pin', pinned: true, tone: 0 }],
      [PEOPLE_ID, 'People', { icon: 'person', pinned: false, tone: 1 }],
    ]
    for (const [id, name, props] of builtIns) {
      if (this.#raw(id)) continue
      this.db.exec(
        `INSERT INTO nodes (id, kind, text, created_at, updated_at, props) VALUES (?, 'category', ?, 0, 0, ?)`,
        [id, name, JSON.stringify(props)],
      )
      this.db.exec(`UPDATE sync_clock SET hlc = '${ZERO_HLC}', local = 0 WHERE node = ?`, [id])
    }
  }

  /** The pad that new items created from the link picker are filed under. */
  inboxId(): string {
    return this.db.tx(() => {
      const row = this.db.get<{ value: string }>(`SELECT value FROM meta WHERE key = 'inbox_id'`)
      const existing = row ? this.#raw(row.value) : undefined
      if (existing && existing.deleted_at === null) return existing.id
      // Another device's Inbox may have arrived by sync: use it rather than making a second one.
      const synced = this.db.get<{ id: string }>(
        `SELECT id FROM nodes WHERE kind = 'pad' AND text = 'Inbox' AND deleted_at IS NULL ORDER BY created_at, id LIMIT 1`,
      )
      const id = synced?.id ?? this.createPad('Inbox')
      this.db.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('inbox_id', ?)`, [id])
      return id
    })
  }

  /** Items made from the link picker are things to link to, so they start as plain bullets. */
  createInInbox(init: NodeInit = {}): string {
    return this.db.tx(() => this.createChild(this.inboxId(), undefined, { task: false, ...init }))
  }

  /** On a brand-new database, create a short welcome pad. Returns its id, or null. */
  seedIfEmpty(): string | null {
    return this.db.tx(() => {
      const seeded = this.db.get(`SELECT value FROM meta WHERE key = 'seeded'`)
      const any = this.db.get(`SELECT id FROM nodes WHERE kind <> 'category' LIMIT 1`)
      if (seeded || any) return null
      this.db.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('seeded', '1')`)
      const pad = this.createPad('Welcome')
      const store = this.createNode('place', 'Hardware store')
      const add = (parent: string, text: string, task = false) => this.createChild(parent, undefined, { text, task })
      add(pad, 'Tap any line to edit it. Enter starts a new line.')
      const tb = add(pad, 'The bar above the keyboard indents, outdents and moves lines')
      add(tb, 'Like this nested line')
      add(pad, 'Lines are notes, like these, or to-dos. The checkbox button in that bar switches a line, and so does typing [] or - at the start of one.')
      const proj = add(pad, 'Fix the sprinkler', true)
      add(proj, `Buy 3/4-inch PVC elbows at [[${store}]]`, true)
      add(proj, `Pick up teflon tape at [[${store}]]`, true)
      add(proj, 'Swap the cracked elbow and test zone 3', true)
      this.setNumbered(proj, true)
      add(pad, 'Type 1. at the start of a line to number its list, like the steps above')
      add(pad, 'Type @ to link to any line, place or person. Tap a link to open it: the Hardware store’s page lists everything you need there, from every list.')
      add(pad, 'Tap a bullet to open that line and see what links to it')
      add(pad, 'Tap the graph button at the top right to see this pad as a graph of its lines and links')
      // Folded, which shows off folding too.
      const more = add(pad, 'More to find (tap the arrow to open)')
      add(more, 'Paste a list from anywhere, markdown too, and it keeps its nesting, checkboxes and numbers')
      add(more, 'Hardware store is a place. Make your own kinds of context, like Rooms or Projects, on the Contexts tab.')
      add(more, 'Install it from your browser’s menu (Install app, or Add to Home screen) to use it offline, like any app')
      add(more, 'On a computer? Settings → Keyboard turns on Vim keys.')
      this.setCollapsed(more, true)
      add(pad, 'Your lists are saved on this device. Settings → Export saves a backup.')
      add(store, 'Closes at 6 on Sundays')
      // The welcome pad is older than any real edit, and isn't sent by sync on its own (see syncPrepareJoin).
      this.db.exec(`UPDATE sync_clock SET hlc = '${ZERO_HLC}', local = 0`)
      return pad
    })
  }

  // ---------------------------------------------------------------- reading

  /** A node, or null if it doesn’t exist (or was emptied from the trash). */
  getNode(id: string): NodeInfo | null {
    const r = this.#raw(id)
    return r && !r.purged ? toInfo(r) : null
  }

  getChildren(id: string): NodeInfo[] {
    const ids = this.#liveChildIds(id)
    const rows = this.#rawMany(ids)
    return ids.map((i) => toInfo(rows.get(i)!))
  }

  /** The node and its live descendants as a nested tree. */
  getTree(rootId: string): TreeNode {
    const rows = this.db.all<
      RawNode & {
        parent: string | null
        edge_key: string | null
        edge_id: string | null
        links: number
        ref_id: string | null
        ref_task: number | null
        ref_done: number | null
      }
    >(
      `WITH RECURSIVE sub(id) AS (
         SELECT ?
         UNION
         SELECT e.dst FROM edges e JOIN sub ON e.src = sub.id JOIN nodes c ON c.id = e.dst
         WHERE e.type = 'child' AND c.deleted_at IS NULL
       )
       SELECT n.id, n.kind, n.text, n.done, n.collapsed, n.created_at, n.updated_at, n.deleted_at, n.sort_key,
              n.numbered, n.task, n.category, n.props, pe.src AS parent, pe.sort_key AS edge_key, pe.id AS edge_id,
              (SELECT count(*) FROM edges l JOIN nodes s ON s.id = l.src
                 WHERE l.dst = n.id AND l.type = 'link' AND s.deleted_at IS NULL AND s.done = 0) AS links,
              t.id AS ref_id, t.task AS ref_task, t.done AS ref_done
       FROM sub JOIN nodes n ON n.id = sub.id
       LEFT JOIN edges pe ON pe.dst = n.id AND pe.type = 'child'
       LEFT JOIN nodes t ON t.id = n.ref AND t.deleted_at IS NULL`,
      [rootId],
    )
    const byId = new Map<string, TreeNode & { _key: string; _edge: string }>()
    for (const r of rows) {
      byId.set(r.id, {
        id: r.id,
        kind: r.kind,
        text: r.text,
        // A line that's only a link is the linked item: its checkbox, its done.
        done: r.ref_id ? !!r.ref_done : !!r.done,
        collapsed: !!r.collapsed,
        numbered: !!r.numbered,
        task: r.ref_id ? !!r.ref_task : !!r.task,
        links: r.links,
        category: effectiveCategory(r),
        ref: r.ref_id,
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
        compareKeys({ sort_key: a._key, dst: a.id }, { sort_key: b._key, dst: b.id }),
      )
      return {
        id: t.id,
        kind: t.kind,
        text: t.text,
        done: t.done,
        collapsed: t.collapsed,
        numbered: t.numbered,
        task: t.task,
        links: t.links,
        category: t.category,
        ref: t.ref,
        children: kids.map(strip),
      }
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
    const cats = this.#categoryMap()
    const out: Record<string, RefInfo> = {}
    for (const id of ids) {
      const r = res.rows.get(id)
      const cat = r ? this.#liveCategory(r, cats) : null
      out[id] = r && !r.purged
        ? {
            id,
            kind: r.kind,
            label: res.label(id) ?? '',
            done: !!r.done,
            task: !!r.task,
            deleted: r.deleted_at !== null,
            tone: cat ? cats.get(cat)!.tone : null,
            exists: true,
          }
        : { id, kind: 'item', label: 'missing', done: false, task: false, deleted: true, tone: null, exists: false }
    }
    return out
  }

  getLabel(id: string): string {
    return this.getRefs([id])[id].label
  }

  getBacklinks(id: string): Backlink[] {
    const rows = this.db.all<RawNode & { phrase: string | null; ref: string | null }>(
      `SELECT ${NODE_COLS.split(', ').map((c) => 's.' + c).join(', ')}, e.phrase, s.ref
       FROM edges e JOIN nodes s ON s.id = e.src
       WHERE e.dst = ? AND e.type = 'link' AND s.deleted_at IS NULL`,
      [id],
    )
    const vocab = this.#vocab()
    const out: Backlink[] = rows.map((r) => {
      const fact = r.facts ? this.#facts(r.id).find((f) => f.to === id) : undefined
      return {
        source: toInfo(r),
        alsoOn: r.ref === id,
        fact: !!fact,
        suggested: r.phrase,
        ...(fact
          ? { phrase: (fact.rel && vocab.names.get(fact.rel)) || fact.name, relationId: fact.rel, pinned: false }
          : this.#resolve(vocab, r.phrase, this.#linkRels(r.id)[id])),
        crumbs: this.getAncestors(r.id),
      }
    })
    const pathOf = (b: Backlink) => b.crumbs.map((c) => c.label).join('\u0000').toLowerCase()
    // Open to-dos, then plain mentions, then finished to-dos.
    const rank = (b: Backlink) => (b.source.done ? 2 : b.source.task ? 0 : 1)
    out.sort((a, b) => {
      if (rank(a) !== rank(b)) return rank(a) - rank(b)
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
    if (!raw || raw.purged) throw new StoreError(`No node ${id}`, 'not_found')
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
    // Links in the text, in the order they appear (facts are listed on their own).
    const order = parseTokens(raw.text)
    const textLinks = outgoingIds.filter((o) => order.includes(o)).sort((a, b) => order.indexOf(a) - order.indexOf(b))
    const relationLinks = raw.kind === 'relation' ? this.getRelationLinks({ relationId: id }) : []
    const suggestedCategory =
      backlinks.length && !this.#liveCategory(raw) && (raw.kind === 'item' || raw.kind === 'place' || raw.kind === 'person')
        ? this.#categorySuggester()(id)
        : null
    for (const l of relationLinks) for (const tok of parseTokens(l.source.text)) tokenIds.add(tok)
    const allRefs = relationLinks.length ? this.getRefs([...tokenIds]) : refs
    return {
      node: toInfo(raw),
      ancestors: this.getAncestors(id),
      tree,
      refs: allRefs,
      outgoing: textLinks.map((o) => refs[o]),
      backlinks,
      relationLinks,
      suggestedCategory,
      facts: this.#factViews(id),
    }
  }

  listPads(): PadSummary[] {
    const pads = this.db.all<RawNode>(
      `SELECT ${NODE_COLS} FROM nodes WHERE kind = 'pad' AND deleted_at IS NULL ORDER BY sort_key, id`,
    )
    const counts = this.db.all<{ pad: string; items: number; tasks: number; open: number }>(
      `WITH RECURSIVE d(pad, id) AS (
         SELECT id, id FROM nodes WHERE kind = 'pad' AND deleted_at IS NULL
         UNION ALL
         SELECT d.pad, e.dst FROM edges e JOIN d ON e.src = d.id JOIN nodes c ON c.id = e.dst
         WHERE e.type = 'child' AND c.deleted_at IS NULL
       )
       SELECT d.pad AS pad, count(*) - 1 AS items,
              sum(CASE WHEN coalesce(t.task, n.task) = 1 AND n.id != d.pad THEN 1 ELSE 0 END) AS tasks,
              sum(CASE WHEN coalesce(t.task, n.task) = 1 AND coalesce(t.done, n.done) = 0 AND n.id != d.pad THEN 1 ELSE 0 END) AS open
       FROM d JOIN nodes n ON n.id = d.id
       LEFT JOIN nodes t ON t.id = n.ref AND t.deleted_at IS NULL
       GROUP BY d.pad`,
    )
    const byPad = new Map(counts.map((c) => [c.pad, c]))
    const res = this.#labelResolver(new Map(pads.map((p) => [p.id, p])))
    res.ensure(pads.flatMap((p) => parseTokens(p.text)))
    return pads.map((p) => ({
      id: p.id,
      text: p.text,
      label: res.label(p.id) ?? '',
      itemCount: byPad.get(p.id)?.items ?? 0,
      taskCount: byPad.get(p.id)?.tasks ?? 0,
      openCount: byPad.get(p.id)?.open ?? 0,
      updated_at: p.updated_at,
    }))
  }

  /** Rows for the move browser: the pads (parentId null) or a node's live children, in order. */
  listBrowse(parentId: string | null): BrowseRow[] {
    const ids =
      parentId === null
        ? this.db
            .all<{ id: string }>(`SELECT id FROM nodes WHERE kind = 'pad' AND deleted_at IS NULL ORDER BY sort_key, id`)
            .map((r) => r.id)
        : this.#liveChildIds(parentId)
    if (ids.length === 0) return []
    const counts = new Map(
      this.db
        .all<{ src: string; c: number }>(
          `SELECT e.src AS src, count(*) AS c FROM edges e JOIN nodes n ON n.id = e.dst
           WHERE e.type = 'child' AND n.deleted_at IS NULL AND e.src IN (SELECT value FROM json_each(?))
           GROUP BY e.src`,
          [JSON.stringify(ids)],
        )
        .map((r) => [r.src, r.c]),
    )
    const refs = this.getRefs(ids)
    return ids.map((id) => ({
      id,
      kind: refs[id].kind,
      label: refs[id].label,
      done: refs[id].done,
      childCount: counts.get(id) ?? 0,
    }))
  }

  /** Index screen for places / people: every live node of that kind. */
  listByKind(kind: Kind): IndexEntry[] {
    const rows = this.db.all<RawNode & { total: number; open: number }>(
      `SELECT ${NODE_COLS.split(', ').map((c) => 'n.' + c).join(', ')},
         (SELECT count(*) FROM edges e JOIN nodes s ON s.id = e.src
            WHERE e.dst = n.id AND e.type = 'link' AND s.deleted_at IS NULL) AS total,
         (SELECT count(*) FROM edges e JOIN nodes s ON s.id = e.src
            WHERE e.dst = n.id AND e.type = 'link' AND s.deleted_at IS NULL AND s.task = 1 AND s.done = 0) AS open
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
    // Relations and the ways you write them are vocabulary, not things to link to; only listed when asked for.
    const relationIds = new Set(all.filter((r) => r.kind === 'relation').map((r) => r.id))
    const wantRelations = !!kinds?.has('relation')
    for (const r of all) {
      if (r.deleted_at !== null || exclude.has(r.id)) continue
      if (kinds && !kinds.has(r.kind)) continue
      if (!wantRelations && (relationIds.has(r.id) || relationIds.has(parentOf.get(r.id) ?? ''))) continue
      if (r.kind === 'category' && !kinds?.has('category')) continue
      // A line that's only a link is that item again, not something to find twice.
      if (r.kind === 'item' && soleLink(r.text)) continue
      if (r.id === NO_RELATION_ID) continue
      const label = res.label(r.id) ?? ''
      if (!label && q) continue
      let score: number
      if (q) {
        const s = fuzzyScore(q, label)
        if (s === null) continue
        score = s + (effectiveCategory(r) ? 8 : r.kind === 'pad' ? 4 : 0) - (r.done ? 10 : 0)
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
      return { id: r.id, kind: r.kind, label, done: !!r.done, context, score, category: effectiveCategory(r) }
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
      `SELECT src, dst, type, phrase FROM edges
       WHERE type IN ('child', 'link')
         AND src IN (SELECT value FROM json_each(?1)) AND dst IN (SELECT value FROM json_each(?1))`,
      [JSON.stringify(ids)],
    )
    // Links show your relation (or the suggestion); only links that say what they mean carry a phrase.
    const vocab = this.#vocab()
    for (const e of edges) {
      if (e.type === 'link') e.phrase = this.#resolve(vocab, e.phrase ?? null, this.#linkRels(e.src)[e.dst]).phrase
      if (e.phrase == null) delete e.phrase
    }
    // Children of numbered lists carry their position, so the graph can lay them out in order.
    const numbered = new Set(
      this.db
        .all<{ id: string }>(`SELECT id FROM nodes WHERE numbered = 1 AND id IN (SELECT value FROM json_each(?))`, [
          JSON.stringify(ids),
        ])
        .map((r) => r.id),
    )
    const order = new Map<string, number>()
    for (const parent of numbered) this.#liveChildIds(parent).forEach((c, i) => order.set(c, i))
    for (const e of edges) {
      if (e.type === 'child' && numbered.has(e.src) && order.has(e.dst)) e.index = order.get(e.dst)
    }
    const refs = this.getRefs(ids)
    const refRows = this.#rawMany(ids)
    const nodes: GraphNode[] = ids.map((n) => ({
      id: n,
      kind: refs[n].kind,
      label: refs[n].label,
      done: refs[n].done,
      task: refs[n].task,
      tone: refs[n].tone,
      category: refs[n].tone != null ? effectiveCategory(refRows.get(n)!) : null,
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
       WHERE n.deleted_at IS NOT NULL AND n.purged = 0
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

  /**
   * Empty the trash: erase the text of soft-deleted nodes and drop their links.
   * The rows stay behind as tombstones (purged = 1) so other devices learn
   * about the deletion when they sync.
   */
  purgeDeleted(): number {
    return this.db.tx(() => {
      const dead = `SELECT id FROM nodes WHERE deleted_at IS NOT NULL`
      this.db.exec(`DELETE FROM edges WHERE type = 'link' AND (src IN (${dead}) OR dst IN (${dead}))`)
      this.db.exec(`UPDATE nodes SET text = '', purged = 1 WHERE deleted_at IS NOT NULL AND purged = 0`)
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

  // ---------------------------------------------------------------- facts
  //
  // A fact is something you state about a node: Alex is "cofounder of"
  // Acme. Facts live on the node they're about (nodes.facts), never
  // guessed from notes; each also makes a labelled link from that node, so the
  // graph and the target's page show it.

  #facts(id: string): Fact[] {
    const raw = this.db.get<{ facts: string | null }>('SELECT facts FROM nodes WHERE id = ?', [id])?.facts
    try {
      const v = raw ? JSON.parse(raw) : []
      return Array.isArray(v) ? v.filter((f) => f && typeof f.to === 'string' && UUID_RE.test(f.to)) : []
    } catch {
      return []
    }
  }

  #setFacts(id: string, facts: Fact[]): void {
    this.db.exec('UPDATE nodes SET facts = ?, updated_at = ? WHERE id = ?', [
      facts.length ? JSON.stringify(facts) : null,
      this.#now(),
      id,
    ])
    this.#reconcileLinks(id, this.#raw(id)!.text)
  }

  #factViews(id: string): FactView[] {
    const facts = this.#facts(id)
    if (!facts.length) return []
    const vocab = this.#vocab()
    const refs = this.getRefs(facts.map((f) => f.to))
    return facts.map((f, index) => ({
      index,
      relationId: f.rel && vocab.names.has(f.rel) ? f.rel : null,
      name: (f.rel && vocab.names.get(f.rel)) || f.name,
      target: refs[f.to],
    }))
  }

  #relationName(relationId: string): string {
    const r = this.#raw(relationId)
    if (!r || r.kind !== 'relation' || r.deleted_at !== null || relationId === NO_RELATION_ID) {
      throw new StoreError('No such relation', 'not_found')
    }
    return cleanLabel(r.text)
  }

  /** State a fact about a node: it is <relation> <target>. Returns its position. */
  addFact(id: string, relationId: string, to: string): number {
    return this.db.tx(() => {
      this.#requireLive(id)
      if (!this.#raw(to)) throw new StoreError(`No node ${to}`, 'not_found')
      if (to === id) throw new StoreError('A fact needs something else to be about', 'self')
      const facts = this.#facts(id)
      const existing = facts.findIndex((f) => f.to === to && f.rel === relationId)
      if (existing >= 0) return existing
      // One relation per target: stating a new one about the same thing replaces it.
      const rest = facts.filter((f) => f.to !== to)
      rest.push({ to, rel: relationId, name: this.#relationName(relationId) })
      this.#setFacts(id, rest)
      return rest.length - 1
    })
  }

  /** Change a fact's relation or what it's about. */
  updateFact(id: string, index: number, patch: { relationId?: string; to?: string }): void {
    this.db.tx(() => {
      this.#requireLive(id)
      const facts = this.#facts(id)
      const f = facts[index]
      if (!f) throw new StoreError('No such fact', 'not_found')
      if (patch.relationId) facts[index] = { ...f, rel: patch.relationId, name: this.#relationName(patch.relationId) }
      if (patch.to) {
        if (patch.to === id || !this.#raw(patch.to)) throw new StoreError('Can’t point it there', 'bad_target')
        facts[index] = { ...facts[index], to: patch.to }
      }
      this.#setFacts(id, facts.filter((x, i) => i === index || x.to !== facts[index].to))
    })
  }

  removeFact(id: string, index: number): void {
    this.db.tx(() => {
      this.#requireLive(id)
      const facts = this.#facts(id)
      if (!facts[index]) throw new StoreError('No such fact', 'not_found')
      facts.splice(index, 1)
      this.#setFacts(id, facts)
    })
  }

  /**
   * Make a note a fact about what it's under: "cofounder of [[Acme]]"
   * under Alex becomes Alex's fact, and the note goes. Returns the subject.
   */
  noteToFact(lineId: string, relationId: string, to?: string): string {
    return this.db.tx(() => {
      const line = this.#requireLive(lineId)
      const pe = this.#parentEdge(lineId)
      if (!pe) throw new StoreError('Only a line under something can be a fact about it', 'no_parent')
      const target = to ?? parseTokens(line.text)[0]
      if (!target) throw new StoreError('The line needs a link to what it’s about', 'no_link')
      this.addFact(pe.src, relationId, target)
      this.deleteSubtree(lineId)
      return pe.src
    })
  }

  /** Turn a fact back into a note under its node ("cofounder of [[Acme]]"). Returns the note's id. */
  factToNote(id: string, index: number): string {
    return this.db.tx(() => {
      const f = this.#factViews(id)[index]
      if (!f) throw new StoreError('No such fact', 'not_found')
      const note = this.createChild(id, undefined, { text: `${f.name} ${makeToken(f.target.id)}`, task: false })
      this.removeFact(id, index)
      return note
    })
  }

  // ------------------------------------------------------------- contexts
  //
  // A context is something you link to and come back to: a place, a person, a
  // room, a project. Its kind is a 'category' node (Places, Rooms…, with
  // settings in props), and nodes.category says which; older place/person
  // nodes belong to the built-in Places/People. Any node can become one where
  // it is: contexts stay in your lists. Kinds are suggested from evidence: a
  // node gets the kind whose contexts you link to the same way.

  #categoryMap(): Map<string, { name: string; icon: string; pinned: boolean; tone: number; created: number }> {
    const out = new Map<string, { name: string; icon: string; pinned: boolean; tone: number; created: number }>()
    for (const r of this.db.all<{ id: string; text: string; props: string | null; created_at: number; sort_key: string | null }>(
      `SELECT id, text, props, created_at, sort_key FROM nodes WHERE kind = 'category' AND deleted_at IS NULL ORDER BY created_at, id`,
    )) {
      let p: CategoryProps = {}
      try {
        p = r.props ? JSON.parse(r.props) : {}
      } catch {
        p = {}
      }
      out.set(r.id, {
        name: cleanLabel(r.text) || 'Untitled',
        icon: typeof p.icon === 'string' ? p.icon : 'tag',
        pinned: !!p.pinned,
        tone: typeof p.tone === 'number' ? p.tone : 2 + (parseInt(r.id.slice(0, 4), 16) % 4),
        created: r.created_at,
      })
    }
    return out
  }

  /** The node's kind of context, if that kind still exists. */
  #liveCategory(r: Pick<RawNode, 'kind' | 'category'>, cats = this.#categoryMap()): string | null {
    const c = effectiveCategory(r)
    return c && cats.has(c) ? c : null
  }

  /** Open and total links into each of these nodes (live sources only). */
  #linkCounts(ids: string[]): Map<string, { open: number; total: number }> {
    const out = new Map<string, { open: number; total: number }>()
    if (!ids.length) return out
    for (const r of this.db.all<{ dst: string; total: number; open: number }>(
      `SELECT e.dst, count(*) AS total, sum(CASE WHEN s.task = 1 AND s.done = 0 AND s.ref IS NULL THEN 1 ELSE 0 END) AS open
       FROM edges e JOIN nodes s ON s.id = e.src
       WHERE e.type = 'link' AND s.deleted_at IS NULL AND e.dst IN (SELECT value FROM json_each(?))
       GROUP BY e.dst`,
      [JSON.stringify(ids)],
    )) {
      out.set(r.dst, { open: r.open, total: r.total })
    }
    return out
  }

  /** Your kinds of context, the built-ins first, with how many contexts and open to-dos each has. */
  listCategories(): CategoryInfo[] {
    const cats = this.#categoryMap()
    const members = this.db.all<{ id: string; kind: Kind; category: string | null }>(
      `SELECT id, kind, category FROM nodes WHERE deleted_at IS NULL AND kind NOT IN ('pad', 'relation', 'category')
         AND (category IS NOT NULL OR kind IN ('place', 'person'))`,
    )
    const byCat = new Map<string, string[]>()
    for (const m of members) {
      const c = this.#liveCategory(m, cats)
      if (c) byCat.set(c, [...(byCat.get(c) ?? []), m.id])
    }
    const counts = this.#linkCounts(members.map((m) => m.id))
    return [...cats].map(([id, c]) => {
      const ids = byCat.get(id) ?? []
      return {
        id,
        name: c.name,
        icon: c.icon,
        pinned: c.pinned,
        tone: c.tone,
        count: ids.length,
        open: ids.reduce((n, m) => n + (counts.get(m)?.open ?? 0), 0),
      }
    })
  }

  #contextEntries(rows: RawNode[], suggest?: (id: string) => string | null): ContextEntry[] {
    const res = this.#labelResolver(new Map(rows.map((r) => [r.id, r])))
    res.ensure(rows.flatMap((r) => parseTokens(r.text)))
    const counts = this.#linkCounts(rows.map((r) => r.id))
    const cats = this.#categoryMap()
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      label: res.label(r.id) ?? '',
      category: this.#liveCategory(r, cats),
      suggested: suggest ? suggest(r.id) : null,
      openBacklinks: counts.get(r.id)?.open ?? 0,
      totalBacklinks: counts.get(r.id)?.total ?? 0,
      updated_at: r.updated_at,
    }))
  }

  /** The contexts of one kind, alphabetically. */
  listContexts(categoryId: string): ContextEntry[] {
    const legacy = categoryId === PLACES_ID ? 'place' : categoryId === PEOPLE_ID ? 'person' : '-'
    const rows = this.db.all<RawNode>(
      `SELECT ${NODE_COLS} FROM nodes WHERE deleted_at IS NULL AND kind NOT IN ('pad', 'relation', 'category')
         AND (category = ? OR (category IS NULL AND kind = ?))`,
      [categoryId, legacy],
    )
    return this.#contextEntries(rows).sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }))
  }

  /** Things you link to that aren't a kind of context yet, most linked first, with a suggested kind. */
  listOtherContexts(): ContextEntry[] {
    const cats = this.#categoryMap()
    const rows = this.db
      .all<RawNode>(
        `SELECT DISTINCT ${NODE_COLS.split(', ').map((c) => 'n.' + c).join(', ')}
         FROM nodes n JOIN edges e ON e.dst = n.id AND e.type = 'link' JOIN nodes s ON s.id = e.src
         WHERE n.deleted_at IS NULL AND s.deleted_at IS NULL AND n.kind IN ('item', 'place', 'person')`,
      )
      .filter((r) => !this.#liveCategory(r, cats))
    const suggest = this.#categorySuggester()
    return this.#contextEntries(rows, suggest).sort(
      (a, b) => b.openBacklinks - a.openBacklinks || b.totalBacklinks - a.totalBacklinks || a.label.localeCompare(b.label),
    )
  }

  /**
   * Suggest a kind from how a node is linked to: each kind has a profile of
   * the relations pointing at its contexts ("buy at", "return to" for Places;
   * "ask", "owes" for People). A node whose own links mostly match a profile
   * gets that kind.
   */
  #categorySuggester(): (id: string) => string | null {
    const cats = this.#categoryMap()
    const links = this.#allLinks().filter((l) => l.phrase)
    const targets = this.#rawMany([...new Set(links.map((l) => l.dst))])
    const profiles = new Map<string, Map<string, number>>()
    const own = new Map<string, Map<string, number>>()
    const bump = (m: Map<string, Map<string, number>>, k: string, phrase: string) => {
      if (!m.has(k)) m.set(k, new Map())
      m.get(k)!.set(phrase, (m.get(k)!.get(phrase) ?? 0) + 1)
    }
    for (const l of links) {
      const t = targets.get(l.dst)
      if (!t) continue
      const c = this.#liveCategory(t, cats)
      if (c) bump(profiles, c, l.phrase!)
      bump(own, l.dst, l.phrase!)
    }
    return (id) => {
      const mine = own.get(id)
      if (!mine) return null
      const total = [...mine.values()].reduce((a, b) => a + b, 0)
      let best: string | null = null
      let bestScore = 0
      for (const [cat, prof] of profiles) {
        const size = [...prof.values()].reduce((a, b) => a + b, 0)
        let score = 0
        for (const [phrase, n] of mine) score += n * ((prof.get(phrase) ?? 0) / size)
        score /= total
        if (score > bestScore) {
          bestScore = score
          best = cat
        }
      }
      return bestScore >= 0.2 ? best : null
    }
  }

  /** A new kind of context. */
  createCategory(name: string, opts: { icon?: string; pinned?: boolean; id?: string } = {}): string {
    return this.db.tx(() => {
      const label = cleanLabel(name)
      if (!label) throw new StoreError('A kind needs a name', 'empty')
      const n = this.db.get<{ c: number }>(`SELECT count(*) AS c FROM nodes WHERE kind = 'category'`)?.c ?? 0
      const id = this.#insertNode('category', label, null, opts.id)
      const props: CategoryProps = { icon: opts.icon ?? 'tag', pinned: !!opts.pinned, tone: 2 + (n % 4) }
      this.db.exec('UPDATE nodes SET props = ? WHERE id = ?', [JSON.stringify(props), id])
      return id
    })
  }

  /** Change a kind's icon or whether it has a tab in the bar. */
  setCategoryProps(id: string, patch: CategoryProps): void {
    this.db.tx(() => {
      const r = this.#requireLive(id)
      if (r.kind !== 'category') throw new StoreError('Not a kind of context', 'not_category')
      let props: CategoryProps = {}
      try {
        props = r.props ? JSON.parse(r.props) : {}
      } catch {
        props = {}
      }
      this.db.exec('UPDATE nodes SET props = ?, updated_at = ? WHERE id = ?', [
        JSON.stringify({ ...props, ...patch }),
        this.#now(),
        id,
      ])
    })
  }

  /** Make a node a context of some kind, where it is (null: not a context any more). */
  setCategory(id: string, categoryId: string | null): void {
    this.db.tx(() => {
      const r = this.#requireLive(id)
      if (r.kind === 'pad' || r.kind === 'relation' || r.kind === 'category') {
        throw new StoreError('Pads and relations can’t be contexts', 'not_context')
      }
      if (categoryId) {
        const c = this.#raw(categoryId)
        if (!c || c.kind !== 'category' || c.deleted_at !== null) throw new StoreError('No such kind', 'not_found')
      }
      this.db.exec('UPDATE nodes SET category = ?, updated_at = ? WHERE id = ?', [categoryId, this.#now(), id])
      // Older places and people belong to their kind by their node kind; make them plain too.
      if (!categoryId && (r.kind === 'place' || r.kind === 'person')) this.setKind(id, 'item')
    })
  }

  /** A new standalone context of a kind (from a kind's page, or the link picker). */
  createContext(text: string, categoryId: string, id?: string): string {
    return this.db.tx(() => {
      const nid = this.#insertNode('item', text, null, id)
      this.setCategory(nid, categoryId)
      return nid
    })
  }

  /**
   * Turn a line into a context. A line inside a list becomes a link to a new
   * standalone context with its text (so the list keeps reading the same); a
   * standalone node just gets the kind. Returns the context's id.
   */
  convertToContext(id: string, categoryId: string, newId?: string): string {
    return this.db.tx(() => {
      const n = this.#requireLive(id)
      if (!this.#parentEdge(id)) {
        this.setCategory(id, categoryId)
        return id
      }
      const ctx = this.createContext(n.text, categoryId, newId)
      this.updateText(id, makeToken(ctx))
      return ctx
    })
  }

  // ------------------------------------------------------------ relations
  //
  // Your vocabulary of relations is ordinary nodes: kind 'relation', named by
  // their text, with the other ways you write them as child lines. Links keep
  // their suggested label (edges.phrase); what you see is resolved when read:
  // a choice pinned on the link (nodes.link_rels), else the relation whose
  // name or alias matches the suggestion, else the suggestion itself. So
  // renames and merges apply everywhere at once, and sync is just nodes.

  #vocab(): Vocab {
    const names = new Map<string, string>()
    const byPhrase = new Map<string, string>()
    for (const r of this.db.all<{ id: string; text: string }>(
      `SELECT id, text FROM nodes WHERE kind = 'relation' AND deleted_at IS NULL`,
    )) {
      names.set(r.id, cleanLabel(r.text))
    }
    for (const a of this.db.all<{ rel: string; text: string }>(
      `SELECT e.src AS rel, c.text FROM edges e JOIN nodes c ON c.id = e.dst JOIN nodes r ON r.id = e.src
       WHERE e.type = 'child' AND r.kind = 'relation' AND r.deleted_at IS NULL AND c.deleted_at IS NULL`,
    )) {
      const k = normPhrase(a.text)
      if (k && !byPhrase.has(k)) byPhrase.set(k, a.rel)
    }
    // A relation's own name beats an alias that happens to match it.
    for (const [id, name] of names) if (id !== NO_RELATION_ID && normPhrase(name)) byPhrase.set(normPhrase(name), id)
    return { byPhrase, names }
  }

  #linkRels(id: string): Record<string, string> {
    const raw = this.db.get<{ v: string | null }>('SELECT link_rels AS v FROM nodes WHERE id = ?', [id])?.v
    try {
      const v = raw ? JSON.parse(raw) : {}
      return v && typeof v === 'object' ? v : {}
    } catch {
      return {}
    }
  }

  /** What a link shows: your relation, or its suggestion, or nothing. */
  #resolve(
    vocab: Vocab,
    suggested: string | null,
    pinnedId: string | undefined,
  ): { phrase: string | null; relationId: string | null; pinned: boolean } {
    if (pinnedId && (pinnedId === NO_RELATION_ID || vocab.names.has(pinnedId))) {
      return { phrase: pinnedId === NO_RELATION_ID ? null : vocab.names.get(pinnedId)!, relationId: pinnedId, pinned: true }
    }
    if (!suggested) return { phrase: null, relationId: null, pinned: false }
    const rid = vocab.byPhrase.get(normPhrase(suggested))
    if (rid === NO_RELATION_ID) return { phrase: null, relationId: NO_RELATION_ID, pinned: false }
    if (rid) return { phrase: vocab.names.get(rid) ?? suggested, relationId: rid, pinned: false }
    return { phrase: suggested, relationId: null, pinned: false }
  }

  /** Every live link (live source), with what it shows. */
  #allLinks() {
    const vocab = this.#vocab()
    const pins = new Map<string, Record<string, string>>()
    const rows = this.db.all<{ src: string; dst: string; phrase: string | null; link_rels: string | null }>(
      `SELECT e.src, e.dst, e.phrase, s.link_rels FROM edges e JOIN nodes s ON s.id = e.src
       WHERE e.type = 'link' AND s.deleted_at IS NULL`,
    )
    return rows.map((r) => {
      if (!pins.has(r.src)) pins.set(r.src, r.link_rels ? this.#linkRels(r.src) : {})
      return { src: r.src, dst: r.dst, suggested: r.phrase, ...this.#resolve(vocab, r.phrase, pins.get(r.src)![r.dst]) }
    })
  }

  /** Your relations, the suggestions not yet kept, and the phrases you ruled out. */
  listRelations(): RelationsData {
    const links = this.#allLinks()
    const counts = new Map<string, number>()
    const suggestions = new Map<string, number>()
    for (const l of links) {
      if (l.relationId) counts.set(l.relationId, (counts.get(l.relationId) ?? 0) + 1)
      else if (l.phrase) suggestions.set(l.phrase, (suggestions.get(l.phrase) ?? 0) + 1)
    }
    const aliasRows = this.db.all<{ rel: string; id: string; text: string }>(
      `SELECT e.src AS rel, c.id, c.text FROM edges e JOIN nodes c ON c.id = e.dst
       WHERE e.type = 'child' AND c.deleted_at IS NULL AND e.src IN (SELECT id FROM nodes WHERE kind = 'relation')
       ORDER BY e.sort_key, c.id`,
    )
    const aliasesOf = (rel: string) => aliasRows.filter((a) => a.rel === rel && a.text.trim()).map(({ id, text }) => ({ id, text }))
    const relations = this.db
      .all<{ id: string; text: string }>(`SELECT id, text FROM nodes WHERE kind = 'relation' AND deleted_at IS NULL`)
      .filter((r) => r.id !== NO_RELATION_ID)
      .map((r) => ({ id: r.id, name: cleanLabel(r.text), aliases: aliasesOf(r.id), count: counts.get(r.id) ?? 0 }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    return {
      relations,
      suggestions: [...suggestions]
        .map(([phrase, count]) => ({ phrase, count }))
        .sort((a, b) => b.count - a.count || a.phrase.localeCompare(b.phrase)),
      ignored: aliasesOf(NO_RELATION_ID),
    }
  }

  /** Every link labelled with a relation (or, for a suggestion, with that phrase). */
  getRelationLinks(key: { relationId: string } | { phrase: string }): RelationLink[] {
    const links = this.#allLinks().filter((l) =>
      'relationId' in key ? l.relationId === key.relationId : !l.relationId && l.phrase === key.phrase,
    )
    const sources = this.#rawMany([...new Set(links.map((l) => l.src))])
    const refs = this.getRefs([...new Set(links.map((l) => l.dst))])
    return links
      .filter((l) => sources.has(l.src))
      .map((l) => ({ source: toInfo(sources.get(l.src)!), crumbs: this.getAncestors(l.src), target: refs[l.dst], pinned: l.pinned }))
      .sort((a, b) => a.target.label.localeCompare(b.target.label) || Number(a.source.done) - Number(b.source.done))
  }

  #relationByName(name: string): string | undefined {
    const k = normPhrase(name)
    return this.db
      .all<{ id: string; text: string }>(`SELECT id, text FROM nodes WHERE kind = 'relation' AND deleted_at IS NULL`)
      .find((r) => r.id !== NO_RELATION_ID && normPhrase(r.text) === k)?.id
  }

  #hasAlias(rel: string, phrase: string): boolean {
    const k = normPhrase(phrase)
    return this.getChildren(rel).some((c) => normPhrase(c.text) === k)
  }

  #addAlias(rel: string, phrase: string): void {
    if (!normPhrase(phrase) || this.#hasAlias(rel, phrase)) return
    this.createChild(rel, undefined, { text: cleanLabel(phrase).toLowerCase(), task: false })
  }

  /** Stop treating a phrase as something you ruled out. */
  #unignore(phrase: string): void {
    const k = normPhrase(phrase)
    for (const c of this.getChildren(NO_RELATION_ID)) if (normPhrase(c.text) === k) this.deleteSubtree(c.id)
  }

  /**
   * Keep a suggested phrase as one of your relations, named `name` (the phrase
   * itself by default). An existing relation of that name gains the phrase as
   * another way of writing it. Returns the relation's id.
   */
  keepRelation(phrase: string, name = phrase): string {
    return this.db.tx(() => {
      const label = cleanLabel(name).toLowerCase()
      if (!label) throw new StoreError('A relation needs a name', 'empty')
      this.#unignore(phrase)
      const rel = this.#relationByName(label) ?? this.#insertNode('relation', label)
      if (normPhrase(phrase) !== normPhrase(label)) this.#addAlias(rel, phrase)
      return rel
    })
  }

  /** Links worded like this are plain mentions. */
  ignorePhrase(phrase: string): void {
    this.db.tx(() => {
      const none = this.#raw(NO_RELATION_ID)
      if (!none) this.#insertNode('relation', 'Not a relation', null, NO_RELATION_ID)
      else if (none.deleted_at !== null) this.db.exec('UPDATE nodes SET deleted_at = NULL WHERE id = ?', [NO_RELATION_ID])
      this.#addAlias(NO_RELATION_ID, phrase)
    })
  }

  /** Links worded like this get their suggested label again. */
  unignorePhrase(phrase: string): void {
    this.db.tx(() => this.#unignore(phrase))
  }

  /** Rename a relation; the old name keeps working. Renaming to another relation's name merges into it. */
  renameRelation(id: string, name: string): string {
    return this.db.tx(() => {
      const r = this.#requireLive(id)
      if (r.kind !== 'relation' || id === NO_RELATION_ID) throw new StoreError('Not a relation', 'not_relation')
      const label = cleanLabel(name).toLowerCase()
      if (!label) throw new StoreError('A relation needs a name', 'empty')
      const other = this.#relationByName(label)
      if (other && other !== id) return this.mergeRelation(id, other)
      if (normPhrase(r.text) !== normPhrase(label)) {
        this.#addAlias(id, r.text)
        this.updateText(id, label)
      }
      return id
    })
  }

  /** Fold one relation into another: its name and other wordings, and links pinned to it. */
  mergeRelation(fromId: string, intoId: string): string {
    return this.db.tx(() => {
      const from = this.#requireLive(fromId)
      const into = this.#requireLive(intoId)
      if (from.kind !== 'relation' || into.kind !== 'relation') throw new StoreError('Not a relation', 'not_relation')
      if (fromId === intoId) return intoId
      for (const c of this.getChildren(fromId)) {
        if (this.#hasAlias(intoId, c.text)) this.deleteSubtree(c.id)
        else this.moveSubtree(c.id, intoId)
      }
      if (fromId !== NO_RELATION_ID) this.#addAlias(intoId, from.text)
      for (const r of this.db.all<{ id: string }>(`SELECT id FROM nodes WHERE instr(link_rels, ?) > 0`, [fromId])) {
        const pins = this.#linkRels(r.id)
        for (const k of Object.keys(pins)) if (pins[k] === fromId) pins[k] = intoId
        this.db.exec('UPDATE nodes SET link_rels = ? WHERE id = ?', [JSON.stringify(pins), r.id])
      }
      this.deleteSubtree(fromId)
      return intoId
    })
  }

  /** Choose the relation for one link (null: back to the usual label). */
  setLinkRelation(srcId: string, dstId: string, relationId: string | null): void {
    this.db.tx(() => {
      this.#requireLive(srcId)
      const pins = this.#linkRels(srcId)
      if (relationId) pins[dstId] = relationId
      else delete pins[dstId]
      const v = Object.keys(pins).length ? JSON.stringify(pins) : null
      this.db.exec('UPDATE nodes SET link_rels = ? WHERE id = ?', [v, srcId])
    })
  }

  // ------------------------------------------------------------------ sync
  //
  // Each node is a set of fields (see SYNC_COLUMNS, plus 'pos'), and each field
  // keeps the newest value by hybrid logical clock. The triggers from
  // migration 5 record local changes in sync_clock; the sync client (sync.ts)
  // sends them with syncCollect/syncAck and merges the server's with syncApply.

  /** Labels the server's model gave this node's links (see migration 7). */
  #rels(id: string): Record<string, { r: string | null; h: string }> {
    const raw = this.db.get<{ rels: string | null }>('SELECT rels FROM nodes WHERE id = ?', [id])?.rels
    if (!raw) return {}
    try {
      const v = JSON.parse(raw)
      return v && typeof v === 'object' ? v : {}
    } catch {
      return {}
    }
  }

  /** The current value of every syncing field of a node. */
  #fieldValues(id: string): Record<string, unknown> | null {
    const r = this.#raw(id)
    if (!r) return null
    const pe = this.#parentEdge(id)
    let props: unknown = null
    try {
      props = r.props ? JSON.parse(r.props) : null
    } catch {
      props = null
    }
    return {
      rels: this.#rels(id),
      link_rels: this.#linkRels(id),
      facts: this.#facts(id),
      category: r.category,
      props,
      kind: r.kind,
      text: r.text,
      done: r.done,
      collapsed: r.collapsed,
      deleted_at: r.deleted_at,
      numbered: r.numbered,
      task: r.task,
      purged: r.purged,
      created_at: r.created_at,
      pos: pe ? { p: pe.src, k: pe.sort_key } : { p: null, k: r.sort_key },
    }
  }

  syncInfo(): SyncInfo {
    const enabled = this.#meta('sync_enabled')
    // A new schema may bring fields this device ignored before: pull everything again.
    const sameSchema = this.#meta('sync_schema') === String(LATEST_SCHEMA_VERSION)
    return {
      deviceId: this.#hlc.device,
      enabled: enabled === undefined ? null : enabled === '1',
      cursor: sameSchema ? Number(this.#meta('sync_cursor') ?? 0) : 0,
      epoch: this.#meta('sync_epoch') ?? null,
      pending: this.db.get<{ c: number }>('SELECT count(DISTINCT node) AS c FROM sync_clock WHERE local = 1')?.c ?? 0,
    }
  }

  syncSetEnabled(on: boolean): void {
    this.#setMeta('sync_enabled', on ? '1' : '0')
  }

  /**
   * Before the first sync on this device: if it holds nothing but the untouched
   * welcome pad, drop it, so joining doesn't add a second copy to everyone.
   * Returns true if it did.
   */
  syncPrepareJoin(): boolean {
    return this.db.tx(() => {
      const builtIn = JSON.stringify([PLACES_ID, PEOPLE_ID])
      if (!this.db.get('SELECT 1 FROM nodes WHERE id NOT IN (SELECT value FROM json_each(?)) LIMIT 1', [builtIn])) return false
      if (this.db.get(`SELECT 1 FROM sync_clock WHERE hlc <> '${ZERO_HLC}' LIMIT 1`)) return false
      this.db.exec('DELETE FROM edges')
      this.db.exec('DELETE FROM nodes WHERE id NOT IN (SELECT value FROM json_each(?))', [builtIn])
      this.db.exec(`DELETE FROM meta WHERE key = 'inbox_id'`)
      return true
    })
  }

  /**
   * Called with the server's database identity. A server we haven't synced
   * with (or one that was reset) gets everything again: every field is marked
   * unsent and we pull from the start. Returns true if that happened.
   */
  syncBegin(epoch: string): boolean {
    if (this.#meta('sync_epoch') === epoch) return false
    this.db.tx(() => {
      this.db.exec(`UPDATE sync_clock SET local = 1 WHERE hlc NOT IN ('${ZERO_HLC}', '${UNKNOWN_HLC}')`)
      this.#setMeta('sync_epoch', epoch)
      this.#setMeta('sync_cursor', '0')
      this.#setMeta('sync_schema', String(LATEST_SCHEMA_VERSION))
    })
    return true
  }

  /** Up to `limit` unsent field changes, with their current values. */
  syncCollect(limit = 2000): SyncChange[] {
    return this.db.tx(() => {
      // Welcome-pad fields (clock 0) have never been sent. Once a node with a
      // real change needs them (it's that node, an ancestor, or a link target),
      // give them a real clock so they go too and the server gets whole nodes.
      this.db.exec(`
        WITH RECURSIVE need(id) AS (
          SELECT DISTINCT node FROM sync_clock WHERE local = 1
          UNION
          SELECT e.src FROM edges e JOIN need ON e.dst = need.id WHERE e.type = 'child'
          UNION
          SELECT e.dst FROM edges e JOIN need ON e.src = need.id WHERE e.type = 'link'
        )
        UPDATE sync_clock SET hlc = hlc_now(), local = 1
        WHERE hlc = '${ZERO_HLC}' AND node IN (SELECT id FROM need)`)
      const rows = this.db.all<{ node: string; field: string; hlc: string }>(
        'SELECT node, field, hlc FROM sync_clock WHERE local = 1 ORDER BY node, field LIMIT ?',
        [limit],
      )
      const values = new Map<string, Record<string, unknown> | null>()
      const out: SyncChange[] = []
      for (const r of rows) {
        if (!values.has(r.node)) values.set(r.node, this.#fieldValues(r.node))
        const v = values.get(r.node)
        if (!v || !(r.field in v)) continue
        out.push({ n: r.node, f: r.field, v: v[r.field], h: r.hlc })
      }
      return out
    })
  }

  /** The server has these: mark them sent, unless they've changed again since. */
  syncAck(changes: Pick<SyncChange, 'n' | 'f' | 'h'>[]): void {
    this.db.tx(() => {
      for (const c of changes) {
        this.db.exec('UPDATE sync_clock SET local = 0 WHERE node = ? AND field = ? AND hlc = ? AND local = 1', [c.n, c.f, c.h])
      }
    })
  }

  /**
   * Merge changes from the server: each field takes the value with the newer
   * clock. Then rebuild links from changed text, keep "only items are to-dos,
   * only to-dos are done", and undo any loop that two devices' moves made in
   * the tree. Those repairs are ordinary local edits, so they sync back.
   * Returns the number of fields that changed.
   */
  syncApply(changes: SyncChange[], at?: { cursor: number; epoch: string }): number {
    return this.db.tx(() => {
      const saveCursor = () => {
        if (!at) return
        this.#setMeta('sync_cursor', String(at.cursor))
        this.#setMeta('sync_epoch', at.epoch)
        this.#setMeta('sync_schema', String(LATEST_SCHEMA_VERSION))
      }
      const valid = changes.filter(
        (c) => c && UUID_RE.test(c.n) && SYNC_FIELDS.has(c.f) && typeof c.h === 'string' && c.h.length <= 80,
      )
      for (const c of valid) this.#hlc.observe(c.h)
      const nodeIds = [...new Set(valid.map((c) => c.n))]
      const clock = new Map<string, string>()
      const ck = (n: string, f: string) => `${n} ${f}`
      if (nodeIds.length) {
        for (const r of this.db.all<{ node: string; field: string; hlc: string }>(
          'SELECT node, field, hlc FROM sync_clock WHERE node IN (SELECT value FROM json_each(?))',
          [JSON.stringify(nodeIds)],
        )) {
          clock.set(ck(r.node, r.field), r.hlc)
        }
      }
      // Newest per field wins; within one batch, the last newest one.
      const best = new Map<string, SyncChange>()
      for (const c of valid) {
        const k = ck(c.n, c.f)
        const mine = clock.get(k)
        const prev = best.get(k)
        if ((mine === undefined || c.h > mine) && (!prev || c.h > prev.h)) best.set(k, c)
      }
      const winners = [...best.values()]
      if (!winners.length) {
        saveCursor()
        return 0
      }

      const fresh = new Set<string>()
      const ensure = (id: string) => {
        if (this.#raw(id)) return
        const t = this.#now()
        this.db.exec(`INSERT INTO nodes (id, kind, text, created_at, updated_at) VALUES (?, 'item', '', ?, ?)`, [id, t, t])
        fresh.add(id)
      }
      const textChanged = new Set<string>()
      const flagsChanged = new Set<string>()
      const moved: string[] = []
      for (const c of winners) {
        if (c.f === 'pos') continue
        ensure(c.n)
        this.db.exec(`UPDATE nodes SET ${c.f} = ? WHERE id = ?`, [SYNC_COLUMNS[c.f](c.v), c.n])
        if (c.f === 'text' || c.f === 'rels' || c.f === 'facts') textChanged.add(c.n)
        if (c.f === 'kind' || c.f === 'task' || c.f === 'done') flagsChanged.add(c.n)
      }
      // Positions last, once every node in the batch exists.
      for (const c of winners) {
        if (c.f !== 'pos') continue
        ensure(c.n)
        const v = (c.v ?? {}) as { p?: unknown; k?: unknown }
        const parent = typeof v.p === 'string' && UUID_RE.test(v.p) && v.p !== c.n ? v.p : null
        const key = typeof v.k === 'string' ? v.k : null
        const pe = this.#parentEdge(c.n)
        if (parent === null) {
          if (pe) this.db.exec('DELETE FROM edges WHERE id = ?', [pe.id])
          this.db.exec('UPDATE nodes SET sort_key = ? WHERE id = ?', [key, c.n])
        } else {
          ensure(parent) // a stand-in until the parent's own fields arrive
          if (pe) this.db.exec('UPDATE edges SET src = ?, sort_key = ? WHERE id = ?', [parent, key, pe.id])
          else
            this.db.exec(
              `INSERT INTO edges (id, src, dst, type, sort_key, created_at) VALUES (?, ?, ?, 'child', ?, ?)`,
              [this.#uuid(), parent, c.n, key, this.#now()],
            )
          this.db.exec('UPDATE nodes SET sort_key = NULL WHERE id = ? AND sort_key IS NOT NULL', [c.n])
          moved.push(c.n)
        }
      }

      // The writes above went through the triggers; give the clocks their real values.
      if (fresh.size) {
        this.db.exec(`UPDATE sync_clock SET hlc = '${UNKNOWN_HLC}', local = 0 WHERE node IN (SELECT value FROM json_each(?))`, [
          JSON.stringify([...fresh]),
        ])
      }
      const newest = new Map<string, string>()
      for (const c of winners) {
        this.db.exec('INSERT OR REPLACE INTO sync_clock (node, field, hlc, local) VALUES (?, ?, ?, 0)', [c.n, c.f, c.h])
        if (c.h > (newest.get(c.n) ?? '')) newest.set(c.n, c.h)
      }
      for (const [id, h] of newest) {
        this.db.exec('UPDATE nodes SET updated_at = max(updated_at, ?) WHERE id = ?', [hlcWall(h), id])
      }

      // Links follow the text. New nodes may also complete links other nodes already had in their text.
      const relink = new Set(textChanged)
      if (fresh.size > 40) {
        for (const r of this.db.all<{ id: string }>(`SELECT id FROM nodes WHERE instr(text, '[[') > 0`)) relink.add(r.id)
      } else {
        for (const id of fresh) {
          for (const r of this.db.all<{ id: string }>('SELECT id FROM nodes WHERE instr(text, ?) > 0', [`[[${id}]]`])) {
            relink.add(r.id)
          }
        }
      }
      for (const id of relink) {
        const r = this.#raw(id)
        if (r) this.#reconcileLinks(id, r.text)
      }

      // Only items are to-dos and only to-dos are done. When two devices' edits
      // disagree, the newer of the two fields decides.
      for (const id of flagsChanged) {
        const r = this.#raw(id)
        if (!r) continue
        if (r.kind !== 'item' && (r.task || r.done)) {
          this.db.exec('UPDATE nodes SET task = 0, done = 0 WHERE id = ?', [id])
        } else if (r.done && !r.task) {
          const at = (f: string) => this.db.get<{ hlc: string }>('SELECT hlc FROM sync_clock WHERE node = ? AND field = ?', [id, f])?.hlc ?? ''
          if (at('done') > at('task')) this.db.exec('UPDATE nodes SET task = 1 WHERE id = ?', [id])
          else this.db.exec('UPDATE nodes SET done = 0 WHERE id = ?', [id])
        }
      }

      this.#breakCycles(moved)
      saveCursor()
      return winners.length
    })
  }

  /**
   * Two devices can each move a node under the other ("A into B" here, "B into
   * A" there). Merged, that's a loop with no way back to a pad. Break each loop
   * at its most recently moved node by filing that node under the Inbox.
   */
  #breakCycles(moved: string[]): void {
    const parentOf = (id: string) => this.#parentEdge(id)?.src ?? null
    const done = new Set<string>()
    for (const start of moved) {
      if (done.has(start)) continue
      const path: string[] = []
      const seen = new Set<string>()
      let cur: string | null = start
      while (cur && !seen.has(cur) && path.length < 10_000) {
        seen.add(cur)
        path.push(cur)
        cur = parentOf(cur)
      }
      path.forEach((p) => done.add(p))
      if (!cur || !seen.has(cur)) continue // reached a root: no loop
      const loop = path.slice(path.indexOf(cur))
      const posAt = (id: string) =>
        this.db.get<{ hlc: string }>(`SELECT hlc FROM sync_clock WHERE node = ? AND field = 'pos'`, [id])?.hlc ?? ''
      const latest = loop.reduce((a, b) => (posAt(b) > posAt(a) ? b : a))
      const inbox = this.inboxId()
      const key = this.#keyAt(inbox, 'last', latest)
      this.db.exec(`UPDATE edges SET src = ?, sort_key = ? WHERE dst = ? AND type = 'child'`, [inbox, key, latest])
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
          `INSERT INTO nodes (${NODE_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            n.id,
            n.kind,
            n.text,
            n.done,
            n.collapsed,
            n.created_at,
            n.updated_at,
            n.deleted_at,
            n.sort_key,
            n.numbered,
            n.task,
            n.purged,
            n.category,
            n.props,
            n.facts,
          ],
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
      // Files from before kinds of context don't have the built-in ones.
      this.#ensureBuiltInCategories()
      // Links are derived from text: rebuild them (with their phrases) rather than trust the file.
      for (const r of this.db.all<{ id: string; text: string }>(`SELECT id, text FROM nodes WHERE instr(text, '[[') > 0`)) {
        this.#reconcileLinks(r.id, r.text)
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
    // Exports from before to-dos existed: every item was checkable.
    const task = kind === 'item' && (n.task === undefined ? true : !!n.task)
    nodes.push({
      id: n.id,
      kind,
      text: isStr(n.text) ? n.text : '',
      done: task && n.done ? 1 : 0,
      collapsed: n.collapsed ? 1 : 0,
      created_at: created,
      updated_at: isNum(n.updated_at) ? n.updated_at : created,
      deleted_at: isNum(n.deleted_at) ? n.deleted_at : null,
      sort_key: isStr(n.sort_key) ? n.sort_key : null,
      numbered: n.numbered ? 1 : 0,
      task: task ? 1 : 0,
      purged: n.purged ? 1 : 0,
      category: isStr(n.category) ? n.category : null,
      props: isStr(n.props) ? n.props : null,
      facts: isStr(n.facts) ? n.facts : null,
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
