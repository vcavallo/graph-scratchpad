import type { Kind, SearchResult } from '@/db/types'

export const KIND_NAMES: Record<Kind, string> = { pad: 'Pad', item: 'Item', place: 'Place', person: 'Person' }

/** Second line for a search result: where an item lives, or what kind of thing it is. */
export function resultContext(r: Pick<SearchResult, 'kind' | 'context'>): string {
  if (r.kind === 'item') return r.context
  return r.context ? `${KIND_NAMES[r.kind]} in ${r.context}` : KIND_NAMES[r.kind]
}
