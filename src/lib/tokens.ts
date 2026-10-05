// Link tokens: node text may contain `[[<uuid>]]`, which renders as a chip.
// Pure helpers, shared by the data layer and the UI.

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'

export const TOKEN_RE_SOURCE = `\\[\\[(${UUID})\\]\\]`

export function tokenRe(): RegExp {
  return new RegExp(TOKEN_RE_SOURCE, 'g')
}

export function makeToken(id: string): string {
  return `[[${id}]]`
}

const SOLE_LINK_RE = new RegExp(`^\\s*${TOKEN_RE_SOURCE}\\s*$`)

/** The id a line links to when the link is all there is on it, else null. */
export function soleLink(text: string): string | null {
  const m = SOLE_LINK_RE.exec(text)
  return m ? m[1].toLowerCase() : null
}

/** Unique link target ids in order of first appearance (lowercased). */
export function parseTokens(text: string): string[] {
  const seen = new Set<string>()
  for (const m of text.matchAll(tokenRe())) seen.add(m[1].toLowerCase())
  return [...seen]
}

export type Segment = { type: 'text'; value: string } | { type: 'link'; id: string }

export function splitTokens(text: string): Segment[] {
  const out: Segment[] = []
  let last = 0
  for (const m of text.matchAll(tokenRe())) {
    const at = m.index!
    if (at > last) out.push({ type: 'text', value: text.slice(last, at) })
    out.push({ type: 'link', id: m[1].toLowerCase() })
    last = at + m[0].length
  }
  if (last < text.length) out.push({ type: 'text', value: text.slice(last) })
  return out
}

/**
 * Replace tokens with labels. `lookup` returns a label for an id, or undefined
 * when unknown.
 */
export function labelize(text: string, lookup: (id: string) => string | undefined): string {
  return text.replace(tokenRe(), (_m, id: string) => lookup(id.toLowerCase()) ?? '…')
}
