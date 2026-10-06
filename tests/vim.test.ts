// Vim keys: what each normal-mode key does to a line.
import { describe, expect, it } from 'vitest'
import { cells, escapeCaret, placeOn, vimKey, type VimResult } from '../src/lib/vim'
import { makeToken } from '../src/lib/tokens'

const L = makeToken('11111111-1111-4111-8111-111111111111')

/** Press keys on a line, starting at a caret; the line, caret and mode after. */
function press(text: string, caret: number, keys: string[]) {
  let pending = ''
  let mode = 'normal'
  let row: VimResult['row']
  for (const k of keys) {
    const r = vimKey(pending, k, text, caret)
    if (!r) return { text, caret, mode, row, passed: k }
    pending = r.pending
    if (r.text !== undefined) text = r.text
    if (r.caret !== undefined) caret = r.caret
    if (r.mode) mode = r.mode
    if (r.row) row = r.row
  }
  return { text, caret, mode, row }
}
const at = (text: string, caret: number, keys: string[]) => press(text, caret, keys).caret

describe('vim keys', () => {
  it('counts a link as one character', () => {
    expect(cells(`a${L}b`)).toEqual([0, 1, 1 + L.length])
    expect(cells('a🙂b')).toEqual([0, 1, 3])
  })

  it('moves along the line', () => {
    const t = 'buy elbows at the store'
    expect(at(t, 0, ['l', 'l'])).toBe(2)
    expect(at(t, 0, ['h'])).toBe(0)
    expect(at(t, 0, ['$'])).toBe(t.length - 1)
    expect(at(t, 0, ['$', 'l'])).toBe(t.length - 1)
    expect(at(t, 8, ['0'])).toBe(0)
    expect(at('   indented', 8, ['^'])).toBe(3)
    expect(at(t, 0, ['w'])).toBe(4)
    expect(at(t, 0, ['w', 'w'])).toBe(11)
    expect(at(t, 0, ['e'])).toBe(2)
    expect(at(t, 0, ['e', 'e'])).toBe(9)
    expect(at(t, 11, ['b'])).toBe(4)
    expect(at(t, 12, ['b'])).toBe(11)
    expect(at('a, b', 0, ['w', 'w'])).toBe(3)
  })

  it('steps over a link in one go', () => {
    const t = `at ${L} now`
    expect(at(t, 0, ['w'])).toBe(3)
    expect(at(t, 3, ['l'])).toBe(3 + L.length)
    expect(at(t, 3, ['w'])).toBe(3 + L.length + 1)
    expect(at(t, 3 + L.length + 1, ['b'])).toBe(3)
    expect(press(t, 3, ['x']).text).toBe('at  now')
  })

  it('goes to other lines', () => {
    expect(press('abc', 2, ['j']).row).toEqual({ action: 'down', place: { column: 2 } })
    expect(press('abc', 1, ['k']).row).toEqual({ action: 'up', place: { column: 1 } })
    expect(press('abc', 0, ['g', 'g']).row).toEqual({ action: 'first' })
    expect(press('abc', 0, ['G']).row).toEqual({ action: 'last' })
    // w at the last word, b at the first: the next or previous line.
    expect(press('one two', 4, ['w']).row).toEqual({ action: 'down', place: 'start' })
    expect(press('one two', 0, ['b']).row).toEqual({ action: 'up', place: 'end' })
    expect(placeOn('short', { column: 9 })).toBe(4)
    expect(placeOn('  two words', 'start')).toBe(2)
    expect(placeOn('two words', 'end')).toBe(4)
    expect(placeOn('', 'end')).toBe(0)
  })

  it('switches to insert mode where vim does', () => {
    expect(press('abc', 1, ['i'])).toMatchObject({ mode: 'insert', caret: 1 })
    expect(press('abc', 1, ['a'])).toMatchObject({ mode: 'insert', caret: 2 })
    expect(press('  abc', 4, ['I'])).toMatchObject({ mode: 'insert', caret: 2 })
    expect(press('abc', 0, ['A'])).toMatchObject({ mode: 'insert', caret: 3 })
    expect(press('abc', 0, ['o'])).toMatchObject({ mode: 'insert', row: { action: 'open-below' } })
    expect(press('abc', 0, ['O'])).toMatchObject({ mode: 'insert', row: { action: 'open-above' } })
    // Esc steps back onto the last character typed.
    expect(escapeCaret('abc', 3)).toBe(2)
    expect(escapeCaret('abc', 0)).toBe(0)
    expect(escapeCaret(`a${L}`, 1 + L.length)).toBe(1)
  })

  it('deletes and changes', () => {
    const t = 'buy elbows at the store'
    expect(press(t, 0, ['x'])).toMatchObject({ text: 'uy elbows at the store', caret: 0 })
    expect(press('abc', 2, ['x'])).toMatchObject({ text: 'ab', caret: 1 })
    expect(press('abc', 2, ['X'])).toMatchObject({ text: 'ac', caret: 1 })
    expect(press(t, 4, ['d', 'w'])).toMatchObject({ text: 'buy at the store', caret: 4 })
    expect(press(t, 4, ['d', 'e'])).toMatchObject({ text: 'buy  at the store' })
    expect(press(t, 4, ['d', '$'])).toMatchObject({ text: 'buy ', caret: 3 })
    expect(press(t, 4, ['D'])).toMatchObject({ text: 'buy ', caret: 3 })
    expect(press(t, 4, ['d', 'b']).text).toBe('elbows at the store')
    expect(press(t, 4, ['c', 'w'])).toMatchObject({ text: 'buy  at the store', caret: 4, mode: 'insert' })
    expect(press(t, 4, ['C'])).toMatchObject({ text: 'buy ', caret: 4, mode: 'insert' })
    expect(press(t, 4, ['c', 'c'])).toMatchObject({ text: '', caret: 0, mode: 'insert' })
    expect(press(t, 0, ['s'])).toMatchObject({ text: 'uy elbows at the store', mode: 'insert' })
    expect(press(t, 0, ['r', 'g'])).toMatchObject({ text: 'guy elbows at the store', caret: 0, mode: 'normal' })
    expect(press(t, 0, ['d', 'd']).row).toEqual({ action: 'delete' })
    // A command that's cancelled leaves the line alone.
    expect(press(t, 4, ['d', 'Escape', 'x']).text).toBe('buy lbows at the store')
  })

  it('indents, folds, and leaves other keys to the editor', () => {
    expect(press('a', 0, ['>', '>']).row).toEqual({ action: 'indent' })
    expect(press('a', 0, ['<', '<']).row).toEqual({ action: 'outdent' })
    expect(press('a', 0, ['z', 'a']).row).toEqual({ action: 'fold-toggle' })
    expect(press('a', 0, ['z', 'c']).row).toEqual({ action: 'fold' })
    // Unknown letters do nothing (and don't type); Tab and Shift belong to the editor.
    expect(press('abc', 1, ['q'])).toMatchObject({ text: 'abc', caret: 1 })
    expect(vimKey('', 'Tab', 'abc', 0)).toBeNull()
    expect(vimKey('d', 'Shift', 'abc', 0)).toBeNull()
  })

  it('yanks, puts, undoes, and opens links', () => {
    expect(press('a', 0, ['y', 'y']).row).toEqual({ action: 'yank' })
    expect(press('a', 0, ['Y']).row).toEqual({ action: 'yank' })
    expect(press('a', 0, ['p']).row).toEqual({ action: 'put-below' })
    expect(press('a', 0, ['P']).row).toEqual({ action: 'put-above' })
    expect(press('a', 0, ['u']).row).toEqual({ action: 'undo' })
    // gx on a chip opens what it links to; anywhere else, the line.
    const t = `at ${L} now`
    expect(press(t, 3, ['g', 'x']).row).toEqual({ action: 'open', link: '11111111-1111-4111-8111-111111111111' })
    expect(press(t, 0, ['g', 'x']).row).toEqual({ action: 'open', link: undefined })
    expect(press('', 0, ['g', 'x']).row).toEqual({ action: 'open', link: undefined })
  })

  it('works on an empty line', () => {
    expect(press('', 0, ['x'])).toMatchObject({ text: '', caret: 0 })
    expect(press('', 0, ['l', '$', 'w'])).toMatchObject({ caret: 0 })
    expect(press('', 0, ['A'])).toMatchObject({ mode: 'insert', caret: 0 })
    expect(press('', 0, ['c', 'w'])).toMatchObject({ mode: 'insert', caret: 0 })
  })
})
