// Web addresses in a bullet's text, so they work as links: full ones
// (https://…), www.…, and bare names on a well-known ending (example.com).

// Endings common enough to link without a scheme; others need https://.
const ENDINGS = 'com|org|net|app|io|dev|co|ai|xyz|info|edu|gov|page|blog|tech|uk|ca|de|fr|nl|eu|au|nz|us|fm|tv|gg'
const URL_RE = new RegExp(
  String.raw`(?:https?://[^\s<>"\u200b]+|www\.[^\s<>"\u200b]+|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:${ENDINGS})(?![a-z0-9-])(?:[/?#][^\s<>"\u200b]*)?)`,
  'gi',
)

export interface FoundUrl {
  start: number
  end: number
  /** As written. */
  text: string
  /** What opening it goes to (https:// added when it was left off). */
  href: string
}

/** Punctuation that ends a sentence rather than an address. */
const TRAILING = /[.,;:!?'"’”)\]]+$/

export function findUrls(text: string): FoundUrl[] {
  const out: FoundUrl[] = []
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index!
    // Part of a longer word, or the domain of an email address: not a link.
    const before = text[start - 1]
    if (before && /[\w@.-]/.test(before)) continue
    let t = m[0]
    // Drop trailing punctuation, but keep a closing bracket the address opened.
    let trail = TRAILING.exec(t)?.[0] ?? ''
    while (trail) {
      const last = trail[trail.length - 1]
      if ((last === ')' && count(t, '(') >= count(t, ')')) || (last === ']' && count(t, '[') >= count(t, ']'))) break
      t = t.slice(0, -1)
      trail = trail.slice(0, -1)
    }
    if (!t.includes('.')) continue
    out.push({ start, end: start + t.length, text: t, href: /^https?:\/\//i.test(t) ? t : `https://${t}` })
  }
  return out
}

const count = (s: string, c: string) => s.split(c).length - 1

/** The address the offset is in, if it's in one. */
export function urlAt(text: string, offset: number): string | undefined {
  return findUrls(text).find((u) => offset >= u.start && offset < u.end)?.href
}

/** Open an address in a new tab (outside an installed app, in the browser). */
export function openUrl(href: string): void {
  window.open(href, '_blank', 'noopener')
}
