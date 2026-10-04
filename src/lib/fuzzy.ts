// Small fuzzy matcher for the @-link dropdown and search screen.
// Every whitespace-separated query word must match the target, either as a
// substring (scored highly, especially at a word start) or as a subsequence.

export function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
}

function isWordStart(s: string, i: number): boolean {
  if (i === 0) return true
  return !/[a-z0-9]/.test(s[i - 1])
}

function wordScore(word: string, target: string): number | null {
  const idx = target.indexOf(word)
  if (idx >= 0) {
    // Prefer an occurrence at a word start, even if it's not the first one.
    let best = idx
    for (let i = idx; i >= 0 && i < target.length; i = target.indexOf(word, i + 1)) {
      if (isWordStart(target, i)) {
        best = i
        break
      }
    }
    let score = 100 + word.length * 4
    if (isWordStart(target, best)) score += 40
    if (best === 0) score += 25
    score -= Math.min(best, 30) * 0.5
    return score
  }
  // Subsequence match.
  let ti = 0
  let gaps = 0
  let runs = 0
  let prevMatch = -2
  for (const ch of word) {
    const found = target.indexOf(ch, ti)
    if (found < 0) return null
    if (found !== prevMatch + 1) {
      runs++
      if (prevMatch >= 0) gaps += found - prevMatch - 1
    }
    if (isWordStart(target, found)) gaps -= 2
    prevMatch = found
    ti = found + 1
  }
  return 30 + word.length * 2 - runs * 6 - Math.min(gaps, 40)
}

/** Returns a score (higher is better) or null when the query doesn't match. */
export function fuzzyScore(query: string, target: string): number | null {
  const q = normalize(query).trim()
  if (!q) return 0
  const t = normalize(target)
  let total = 0
  for (const word of q.split(/\s+/)) {
    const s = wordScore(word, t)
    if (s === null) return null
    total += s
  }
  if (t === q) total += 60
  return total - Math.min(t.length, 200) * 0.1
}
