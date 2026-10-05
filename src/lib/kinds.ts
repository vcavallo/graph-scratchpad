import type { Kind, SearchResult } from '@/db/types'

export const KIND_NAMES: Record<Kind, string> = {
  pad: 'Pad',
  item: 'Item',
  place: 'Place',
  person: 'Person',
  relation: 'Relation',
  category: 'Kind',
}

/** "Places" → "Place", "Rooms" → "Room", "People" → "Person": for "a Place in …". */
export function singular(name: string): string {
  if (/^people$/i.test(name)) return name[0] === 'P' ? 'Person' : 'person'
  if (/[^aeiou]ies$/i.test(name)) return name.slice(0, -3) + 'y'
  if (/(ches|shes|sses|xes)$/i.test(name)) return name.slice(0, -2)
  if (/[^s]s$/i.test(name) && name.length > 3) return name.slice(0, -1)
  return name
}

/** Second line for a search result: where an item lives, or what kind of thing it is. */
export function resultContext(r: Pick<SearchResult, 'kind' | 'context'>, categoryName?: string): string {
  const what = categoryName ? singular(categoryName) : r.kind === 'item' ? '' : KIND_NAMES[r.kind]
  if (!what) return r.context
  return r.context ? `${what} in ${r.context}` : what
}
