// Types shared by the worker-side data layer and the UI.
// Everything here must be structured-cloneable (it crosses postMessage).

export type Kind = 'pad' | 'item' | 'place' | 'person' | 'relation'
export const KINDS: readonly Kind[] = ['pad', 'item', 'place', 'person', 'relation']

/**
 * The relation that means "not a relation": phrases filed under it label
 * nothing. A fixed id, so devices that create it separately end up with one.
 */
export const NO_RELATION_ID = '00000000-0000-4000-8000-00000000a11a'

export type EdgeType = 'child' | 'link'

/** A row of `nodes` as stored (integers, not booleans). Used by export/import. */
export interface RawNode {
  id: string
  kind: Kind
  text: string
  done: number
  collapsed: number
  created_at: number
  updated_at: number
  deleted_at: number | null
  sort_key: string | null
  /** 1 when this node's children form a numbered list. */
  numbered: number
  /** 1 when this item is a to-do (has a checkbox); 0 for a plain bullet. */
  task: number
  /** 1 once emptied from the trash; the row stays so the deletion can sync. */
  purged: number
}

/** A row of `edges` as stored. */
export interface RawEdge {
  id: string
  src: string
  dst: string
  type: string
  sort_key: string | null
  created_at: number
}

export interface NodeInfo {
  id: string
  kind: Kind
  text: string
  done: boolean
  collapsed: boolean
  created_at: number
  updated_at: number
  deleted: boolean
  numbered: boolean
  task: boolean
}

export interface TreeNode {
  id: string
  kind: Kind
  text: string
  done: boolean
  collapsed: boolean
  /** Children are a numbered list. */
  numbered: boolean
  /** A to-do (checkbox) rather than a plain bullet. Only items can be to-dos. */
  task: boolean
  /** Live links pointing at this node, not counting finished to-dos. */
  links: number
  children: TreeNode[]
}

/** What a link chip needs to render a reference to another node. */
export interface RefInfo {
  id: string
  kind: Kind
  /** The node's text with nested link tokens replaced by their labels. */
  label: string
  done: boolean
  task: boolean
  deleted: boolean
  /** False when the token points at an id that doesn't exist at all. */
  exists: boolean
}

export interface Crumb {
  id: string
  kind: Kind
  label: string
}

export interface Backlink {
  source: NodeInfo
  /** What the link means: your relation's name, or a suggestion ("buy at", "waiting on"), or null. */
  phrase: string | null
  /** The relation it belongs to, if you've kept one for it (NO_RELATION_ID when ruled out). */
  relationId: string | null
  /** The suggestion it came from (the server's label or the device's guess), before your vocabulary. */
  suggested: string | null
  /** You chose the relation for this one link. */
  pinned: boolean
  /** Ancestors of the source, root (pad) first, not including the source. */
  crumbs: Crumb[]
}

export interface NodeViewData {
  node: NodeInfo
  /** Ancestors, root first, not including the node itself. */
  ancestors: Crumb[]
  tree: TreeNode
  refs: Record<string, RefInfo>
  outgoing: RefInfo[]
  backlinks: Backlink[]
  /** For a relation: every link labelled with it. */
  relationLinks: RelationLink[]
}

export interface PadSummary {
  id: string
  label: string
  text: string
  itemCount: number
  /** To-dos in the pad, and how many of them are still open. */
  taskCount: number
  openCount: number
  updated_at: number
}

export interface IndexEntry {
  id: string
  kind: Kind
  label: string
  text: string
  /** Open to-dos linking here. */
  openBacklinks: number
  /** Everything linking here: to-dos (done or not) and plain bullets. */
  totalBacklinks: number
  updated_at: number
}

export interface SearchResult {
  id: string
  kind: Kind
  label: string
  done: boolean
  /** Breadcrumb text such as "Groceries › Produce"; empty for roots. */
  context: string
  score: number
}

/** A row in the move browser. */
export interface BrowseRow {
  id: string
  kind: Kind
  label: string
  done: boolean
  /** Live children (how much is inside). */
  childCount: number
}

export interface SearchOptions {
  limit?: number
  kinds?: Kind[]
  excludeIds?: string[]
}

export interface GraphNode {
  id: string
  kind: Kind
  label: string
  done: boolean
  task: boolean
  hop: number
}

export interface GraphEdge {
  src: string
  dst: string
  type: EdgeType
  /** For child edges under a numbered parent: the child's position (0-based). */
  index?: number
  /** For links: what the link means (your relation, or a suggestion). */
  phrase?: string | null
}

/** A relation you've kept, with the other ways you write it. */
export interface RelationEntry {
  id: string
  name: string
  aliases: { id: string; text: string }[]
  /** Live links labelled with it. */
  count: number
}

export interface RelationsData {
  relations: RelationEntry[]
  /** Labels in use that aren't one of your relations yet, most used first. */
  suggestions: { phrase: string; count: number }[]
  /** Phrases you said aren't relations. */
  ignored: { id: string; text: string }[]
}

/** One link of a given relation: the line, and what it links to. */
export interface RelationLink {
  source: NodeInfo
  crumbs: Crumb[]
  target: RefInfo
  pinned: boolean
}

export interface Neighborhood {
  center: string
  nodes: GraphNode[]
  edges: GraphEdge[]
  truncated: boolean
}

export interface ExportFile {
  app: 'graph-scratchpad'
  format: 1
  schema_version: number
  exported_at: number
  nodes: RawNode[]
  edges: RawEdge[]
}

export interface ImportResult {
  nodes: number
  edges: number
}

export interface DbInfo {
  schemaVersion: number
  sqliteVersion: string
  nodeCount: number
  edgeCount: number
  /** 'opfs-sahpool' when persisted, 'memory' when we fell back to a transient DB. */
  storage: 'opfs-sahpool' | 'memory'
}

export interface DeletedEntry {
  id: string
  kind: Kind
  label: string
  deleted_at: number
  /** Number of nodes deleted together with this one (including itself). */
  count: number
  crumbs: Crumb[]
}

/** One field of one node as exchanged with the sync server (short keys: it's the wire format). */
export interface SyncChange {
  /** Node id. */
  n: string
  /** Field: kind, text, done, collapsed, deleted_at, numbered, task, purged, created_at, or pos. */
  f: string
  /** Value; for pos, { p: parent id or null, k: sort key }. */
  v: unknown
  /** Hybrid logical clock time of the change (see hlc.ts). */
  h: string
}

export interface SyncInfo {
  deviceId: string
  /** null until sync has been turned on or off on this device. */
  enabled: boolean | null
  /** Server sequence number we've pulled up to. */
  cursor: number
  /** Identity of the server database we synced with (a new one means start over). */
  epoch: string | null
  /** Nodes with changes not yet sent. */
  pending: number
}
