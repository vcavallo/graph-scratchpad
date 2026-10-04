import { describe, expect, it } from 'vitest'
import { fuzzyScore } from '../src/lib/fuzzy'
import { labelize, makeToken, parseTokens, splitTokens } from '../src/lib/tokens'
import { pasteLines, typedMarker } from '../src/lib/editorDom'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

describe('tokens', () => {
  it('parses unique ids in order', () => {
    expect(parseTokens(`x ${makeToken(B)} y ${makeToken(A)} ${makeToken(B)}`)).toEqual([B, A])
    expect(parseTokens('[[not-a-uuid]] [[]]')).toEqual([])
  })

  it('lowercases ids', () => {
    expect(parseTokens(`[[${A.toUpperCase()}]]`)).toEqual([A])
  })

  it('splits text into segments', () => {
    expect(splitTokens(`a${makeToken(A)}b`)).toEqual([
      { type: 'text', value: 'a' },
      { type: 'link', id: A },
      { type: 'text', value: 'b' },
    ])
    expect(splitTokens('')).toEqual([])
  })

  it('labelizes', () => {
    expect(labelize(`go to ${makeToken(A)} and ${makeToken(B)}`, (id) => (id === A ? 'Store' : undefined))).toBe(
      'go to Store and …',
    )
  })
})

describe('fuzzy', () => {
  it('ranks prefix and word starts above inner matches', () => {
    const t = ['Hardware store', 'Shard', 'The hard way']
    const ranked = t
      .map((x) => [x, fuzzyScore('hard', x)] as const)
      .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
      .map((x) => x[0])
    expect(ranked[0]).toBe('Hardware store')
    expect(ranked[2]).toBe('Shard')
  })

  it('requires every word to match', () => {
    expect(fuzzyScore('pvc elbow', '3/4 inch PVC elbows')).not.toBeNull()
    expect(fuzzyScore('pvc tee', '3/4 inch PVC elbows')).toBeNull()
  })

  it('matches subsequences and ignores accents and case', () => {
    expect(fuzzyScore('hdwr', 'Hardware')).not.toBeNull()
    expect(fuzzyScore('cafe', 'Café Olé')).not.toBeNull()
    expect(fuzzyScore('xyz', 'Hardware')).toBeNull()
  })
})

describe('list markers', () => {
  it('recognises markers typed at the start of a line', () => {
    expect(typedMarker('[] milk')).toEqual({ length: 3, task: true, done: false })
    expect(typedMarker('[ ] ')).toEqual({ length: 4, task: true, done: false })
    expect(typedMarker('[x] ')).toEqual({ length: 4, task: true, done: true })
    expect(typedMarker('- ')).toEqual({ length: 2, task: false, done: false })
    expect(typedMarker('* ')).toEqual({ length: 2, task: false, done: false })
    expect(typedMarker('-5 degrees')).toBeNull()
    expect(typedMarker('a - b')).toBeNull()
  })

  it('keeps checkboxes from pasted lines and drops other markers', () => {
    expect(pasteLines('- [ ] milk\n- [x] eggs\n* bread\n\n  plain  \n[] jam')).toEqual([
      { text: 'milk', task: true, done: false },
      { text: 'eggs', task: true, done: true },
      { text: 'bread' },
      { text: 'plain' },
      { text: 'jam', task: true, done: false },
    ])
  })
})
