// Types shared by the worker-side data layer and the UI.
// Everything here must be structured-cloneable (it crosses postMessage).

export type Kind = 'pad' | 'item' | 'place' | 'person'
export const KINDS: readonly Kind[] = ['pad', 'item', 'place', 'person']

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
}

export interface TreeNode {
  id: string
  kind: Kind
  text: string
  done: boolean
  collapsed: boolean
  /** Children are a numbered list. */
  numbered: boolean
  children: TreeNode[]
}

/** What a link chip needs to render a reference to another node. */
export interface RefInfo {
  id: string
  kind: Kind
  /** The node's text with nested link tokens replaced by their labels. */
  label: string
  done: boolean
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
}

export interface PadSummary {
  id: string
  label: string
  text: string
  itemCount: number
  openCount: number
  updated_at: number
}

export interface IndexEntry {
  id: string
  kind: Kind
  label: string
  text: string
  openBacklinks: number
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
  hop: number
}

export interface GraphEdge {
  src: string
  dst: string
  type: EdgeType
  /** For child edges under a numbered parent: the child's position (0-based). */
  index?: number
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
