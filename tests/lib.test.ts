import { describe, expect, it } from 'vitest'
import { fuzzyScore } from '../src/lib/fuzzy'
import { labelize, makeToken, parseTokens, splitTokens } from '../src/lib/tokens'
import { pasteLines, typedMarker } from '../src/lib/editorDom'
import { linkContexts } from '../src/lib/relations'

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

  it('reads "1. " and "1) " as numbering the list, where asked', () => {
    expect(typedMarker('1. ', { numbers: true })).toEqual({ length: 3, done: false, numbered: true })
    expect(typedMarker('12) step', { numbers: true })).toEqual({ length: 4, done: false, numbered: true })
    expect(typedMarker('1. ')).toBeNull() // titles keep it as text
    expect(typedMarker('1.5 inches', { numbers: true })).toBeNull()
    expect(typedMarker('2026. ', { numbers: true })).toBeNull()
  })

  it('drops numbers from pasted lines and remembers they were numbered', () => {
    expect(pasteLines('1. Unplug it\n2) Open the case\n3.5 inch screws')).toEqual([
      { text: 'Unplug it', task: false, numbered: true, children: [] },
      { text: 'Open the case', task: false, numbered: true, children: [] },
      { text: '3.5 inch screws', children: [] },
    ])
  })

  it('keeps checkboxes, makes bullets notes, and leaves unmarked lines to follow', () => {
    expect(pasteLines('- [ ] milk\n- [x] eggs\n* bread\n\nplain  \n[] jam\n1. [ ] first')).toEqual([
      { text: 'milk', task: true, done: false, children: [] },
      { text: 'eggs', task: true, done: true, children: [] },
      { text: 'bread', task: false, children: [] },
      { text: 'plain', children: [] },
      { text: 'jam', task: true, done: false, children: [] },
      { text: 'first', task: true, done: false, numbered: true, children: [] },
    ])
  })

  // Just the shape: text, with children when there are any.
  type Shape = string | [string, Shape[]]
  const shape = (lines: ReturnType<typeof pasteLines>): Shape[] =>
    lines.map((l) => (l.children.length ? [l.text, shape(l.children)] : l.text))

  it('nests pasted lines by indentation, whatever its width', () => {
    const md = ['- Garage cleanout', '  1. Sort the shelves', '  2. [ ] Haul boxes', '     - [x] borrow the truck', '  - ask about paint', '- [ ] Buy PVC elbows'].join('\n')
    expect(shape(pasteLines(md))).toEqual([
      ['Garage cleanout', ['Sort the shelves', ['Haul boxes', ['borrow the truck']], 'ask about paint']],
      'Buy PVC elbows',
    ])
    // Tabs, four spaces, and a line indented too far: one level each.
    expect(shape(pasteLines('a\n\tb\n\t\t\t\tc\n    d\ne'))).toEqual([['a', [['b', ['c']], 'd']], 'e'])
    // A dedent between two levels goes under the shallower one.
    expect(shape(pasteLines('a\n    b\n  c'))).toEqual([['a', ['b', 'c']]])
    // Copied from the middle of a document: the first line's indent is the top level.
    expect(shape(pasteLines('    a\n      b\n    c'))).toEqual([['a', ['b']], 'c'])
  })

  it('makes headings parents of what follows them, by level', () => {
    const md = ['# Groceries', '- milk', '  - oat', '## Later', '[ ] flour', '# House ##', 'Fix the gate', '---', '#hashtag stays text'].join('\n')
    const lines = pasteLines(md)
    expect(shape(lines)).toEqual([
      ['Groceries', [['milk', ['oat']], ['Later', ['flour']]]],
      ['House', ['Fix the gate', '#hashtag stays text']],
    ])
    expect(lines[0].task).toBe(false)
  })
})

describe('link relations', () => {
  const S = '33333333-3333-4333-8333-333333333333'
  const phrase = (text: string, id = A) => linkContexts(text.replace(/@/g, makeToken(id))).get(id)?.phrase ?? null

  it('reads the words before a link', () => {
    expect(phrase('Buy 3/4-inch PVC elbows at @')).toBe('buy at')
    expect(phrase('Pick up teflon tape at @ today')).toBe('pick up at')
    expect(phrase('Drop off returns at the @')).toBe('drop off at')
    expect(phrase('waiting on @')).toBe('waiting on')
    expect(phrase('Get everything on the @')).toBe('get on')
    expect(phrase('Ideas from @, mostly good')).toBe('from')
    expect(phrase('Call @ about the ladder')).toBe('call')
    expect(phrase('Ask @ which zone leaks')).toBe('ask')
    expect(phrase('Borrow @’s ladder')).toBe('borrow')
  })

  it('reads the words after a link that opens its clause', () => {
    expect(phrase('@ owes me $20')).toBe('owes')
    expect(phrase('@ closes at 6 on Sundays')).toBe('closes')
    expect(phrase('@ is waiting on parts')).toBe('waiting on')
    expect(phrase("@'s ladder is broken")).toBeNull()
    expect(phrase('Sprinkler: @ said zone 3')).toBe('said')
  })

  it('treats a bare mention as no relation, and carries a relation across "and"', () => {
    expect(phrase('@')).toBeNull()
    expect(phrase('Thinking about @ stuff')).toBe('thinking about')
    const text = `Lunch with ${makeToken(A)} and ${makeToken(S)}`
    const ctx = linkContexts(text)
    expect([ctx.get(A)?.phrase, ctx.get(S)?.phrase]).toEqual(['with', 'with'])
  })

  it('keeps the surrounding words for later', () => {
    const ctx = linkContexts(`Buy elbows at ${makeToken(A)} before Saturday. Then rest`).get(A)!
    expect(ctx.before).toBe('buy elbows at')
    expect(ctx.after).toBe('before saturday')
  })
})
