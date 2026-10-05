// What a link means, guessed from the words around it: "buy elbows at
// [[Hardware store]]" → "buy at", "waiting on [[Sam]]" → "waiting on",
// "borrow [[Sam]]'s ladder" → "borrow", "[[Sam]] owes me $20" → "owes".
// A quick local guess, made on every save; it labels links on hub pages and
// in the graph. Later a model on the server can refine it from the same
// context (the words before and after the link, within its clause).

import { splitTokens } from './tokens'

/** Bump when the guessing changes, so stored phrases are recomputed. */
export const PHRASES_VERSION = '1'

export interface LinkContext {
  /** Up to six words before the link, within its clause, as written. */
  before: string
  /** Up to six words after it, within its clause. */
  after: string
  /** Short relation guess, lowercase, or null for a plain mention. */
  phrase: string | null
}

// Clause boundaries: sentence punctuation, dashes, brackets, commas, line breaks.
const BOUNDARY = /[.;:!?\n—–()[\],]/
const ARTICLES = new Set(['the', 'a', 'an', 'my', 'our', 'your', 'his', 'her', 'their', 'this', 'that', 'some', 'all'])
const PREPOSITIONS = new Set([
  'at', 'on', 'to', 'for', 'from', 'with', 'about', 'in', 'into', 'by', 'via', 'of', 'near', 'around', 're', 'w/', 'onto',
])
const PARTICLES = new Set(['up', 'off', 'out', 'back', 'over', 'down', 'in'])
const AUXILIARIES = new Set(['is', 'are', 'was', 'were', 'has', 'have', 'had', 'will', 'would', 'can', 'could', 'should', 'might', 'may', 'does', 'did', 'just', 'still'])
// Verbs that start to-dos. Not exhaustive: words ending in -ing count too.
const VERBS = new Set([
  'buy', 'get', 'pick', 'grab', 'return', 'drop', 'bring', 'take', 'send', 'mail', 'ship', 'order', 'pay', 'call', 'text',
  'email', 'ask', 'tell', 'remind', 'meet', 'visit', 'see', 'show', 'give', 'lend', 'borrow', 'owe', 'owes', 'wait',
  'book', 'schedule', 'cancel', 'fix', 'clean', 'check', 'read', 'watch', 'follow', 'discuss', 'talk', 'thank', 'invite',
  'message', 'ping', 'pay', 'sell', 'rent', 'find', 'look', 'go', 'stop', 'try', 'use', 'store', 'move', 'put', 'leave',
  'collect', 'deliver', 'renew', 'register', 'sign', 'submit', 'review', 'share', 'help', 'hire', 'contact', 'reply',
  'respond', 'write', 'plan', 'prep', 'cook', 'make', 'fill', 'refill', 'charge', 'swap', 'exchange', 'replace', 'install',
])

// Words ending in -ing that aren't verbs.
const NOT_VERBS = new Set([
  'everything', 'something', 'anything', 'nothing', 'thing', 'things', 'morning', 'evening', 'building', 'ceiling',
  'clothing', 'wedding', 'spring', 'string', 'sibling', 'pudding', 'awning', 'lightning', 'during', 'parking', 'icing',
])

const isVerb = (w: string | undefined) => !!w && !NOT_VERBS.has(w) && (VERBS.has(w) || (w.length > 4 && w.endsWith('ing')))

function words(s: string): string[] {
  return s
    .split(/\s+/)
    .map((w) => w.replace(/^["'“‘(]+|["'”’)]+$/g, '').toLowerCase())
    .filter(Boolean)
}

/** The text of the clause on one side of a link, up to the nearest boundary or other link. */
function clauseSide(parts: ReturnType<typeof splitTokens>, i: number, dir: -1 | 1): string {
  const seg = parts[i + dir]
  if (!seg || seg.type !== 'text') return ''
  const s = seg.value
  if (dir < 0) {
    let cut = -1
    for (let k = s.length - 1; k >= 0; k--) {
      if (BOUNDARY.test(s[k])) {
        cut = k
        break
      }
    }
    return s.slice(cut + 1)
  }
  const m = BOUNDARY.exec(s)
  return m ? s.slice(0, m.index) : s
}

function guess(before: string[], after: string[], possessive: boolean): string | null {
  const b = [...before]
  while (b.length && ARTICLES.has(b[b.length - 1])) b.pop()
  const last = b[b.length - 1]
  if (last && PREPOSITIONS.has(last)) {
    const prev = b[b.length - 2]
    // "waiting on", "talk to"
    if (isVerb(prev)) return `${prev} ${last}`
    // "pick up at", "drop off at"
    if (prev && PARTICLES.has(prev) && isVerb(b[b.length - 3])) return `${b[b.length - 3]} ${prev} ${last}`
    // "buy 3/4-inch elbows at", "pick up teflon tape at": the clause's verb plus the preposition
    if (isVerb(b[0]) && b.length > 2) {
      const particle = PARTICLES.has(b[1]) ? ` ${b[1]}` : ''
      return `${b[0]}${particle} ${last}`
    }
    return last
  }
  // "call [[Sam]]", "drop off [[the returns]]"
  if (last && PARTICLES.has(last) && isVerb(b[b.length - 2])) return `${b[b.length - 2]} ${last}`
  if (isVerb(last)) return last
  // The link opens its clause: "[[Sam]] owes me $20", "[[Ann]] is waiting on parts"
  // (but not "[[Sam]]'s ladder": that's about the ladder).
  if (!b.length && !possessive) {
    const a = after
    let k = 0
    while (k < a.length && AUXILIARIES.has(a[k])) k++
    const w = a[k]
    if (w && !PREPOSITIONS.has(w) && !ARTICLES.has(w) && /^[a-z]+$/.test(w)) {
      return PREPOSITIONS.has(a[k + 1]) && isVerb(w) ? `${w} ${a[k + 1]}` : w
    }
  }
  return null
}

/** Context and guessed relation for each link in a text (first occurrence of each target). */
export function linkContexts(text: string): Map<string, LinkContext> {
  const parts = splitTokens(text)
  const out = new Map<string, LinkContext>()
  let previous: string | null = null
  parts.forEach((p, i) => {
    if (p.type !== 'link') return
    const beforeText = clauseSide(parts, i, -1)
    let afterText = clauseSide(parts, i, 1)
    const possessive = /^['’]s\b/.test(afterText)
    if (possessive) afterText = afterText.slice(2)
    const before = words(beforeText)
    const after = words(afterText)
    // "lunch with [[Sam]] and [[Ann]]": Ann gets Sam's relation.
    const joined = before.length === 1 && ['and', 'or', '&', '+'].includes(before[0])
    const phrase = joined && previous ? previous : guess(before, after, possessive)
    previous = phrase
    if (out.has(p.id)) return
    out.set(p.id, { before: before.slice(-6).join(' '), after: after.slice(0, 6).join(' '), phrase })
  })
  return out
}
