// The server's link labeller, with a stand-in for the model.
import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { SyncServer } from '../server/sync-server.mjs'
import { RelationLabeler, cleanRelation, textHash as serverHash, type Classifier, type LabelItem } from '../server/relations-ai.mjs'
import { textHash } from '../src/lib/textHash'
import { syncOnce, type Transport } from '../src/db/sync'
import { makeToken } from '../src/lib/tokens'
import { makeStore } from './helpers'

function setup(answer: (item: LabelItem) => string | null, opts: { maxCallsPerDay?: number; batch?: number } = {}) {
  const server = new SyncServer(new DatabaseSync(':memory:'))
  const calls: { items: LabelItem[]; vocabulary: string[] }[] = []
  const classify: Classifier = async (items, vocabulary) => {
    calls.push({ items, vocabulary })
    return { labels: items.map((i) => ({ id: i.id, relation: answer(i) })), usage: { input_tokens: 100, output_tokens: 10 } }
  }
  const labeler = new RelationLabeler(server, classify, { log: () => {}, ...opts })
  const link: Transport = async (req) => JSON.parse(JSON.stringify(server.sync(JSON.parse(JSON.stringify(req)))))
  return { server, labeler, calls, link }
}

describe('server link labels', () => {
  it('hashes text the same on the server and the devices', () => {
    for (const s of ['', 'buy at [[x]]', 'café ✓ 日本 🙂', 'a'.repeat(1000)]) expect(serverHash(s)).toBe(textHash(s))
  })

  it('cleans what the model says', () => {
    expect(cleanRelation(' Buy At ')).toBe('buy at')
    expect(cleanRelation('null')).toBeNull()
    expect(cleanRelation('one two three four five')).toBeNull()
    expect(cleanRelation(42)).toBeNull()
  })

  it('labels links on the server, and devices use those labels while the text is unchanged', async () => {
    const { labeler, calls, link } = setup((i) => (i.line.includes('at ⟦') ? 'buy at' : 'ask'))
    const s = await makeStore()
    const pad = s.createPad('P')
    const shop = s.createNode('place', 'Shop')
    const sam = s.createNode('person', 'Sam')
    const x = s.createChild(pad, undefined, { text: `Pick up tape at ${makeToken(shop)}, remind ${makeToken(sam)}` })
    await syncOnce(s, link)
    expect(s.getBacklinks(shop)[0].phrase).toBe('pick up at') // the device's own guess

    await labeler.run()
    expect(calls).toHaveLength(1)
    const lines = calls[0].items.map((i) => i.line)
    expect(lines).toContain('Pick up tape at ⟦Shop⟧, remind Sam')
    expect(calls[0].items.find((i) => i.line.includes('⟦Shop⟧'))).toMatchObject({ linked: 'place', under: 'P' })
    expect(labeler.pending()).toHaveLength(0)

    await syncOnce(s, link)
    expect(s.getBacklinks(shop)[0].phrase).toBe('buy at')
    expect(s.getBacklinks(sam)[0].phrase).toBe('ask')

    // Edited text: back to the device's guess until the server reads it again.
    s.updateText(x, `Grab tape at ${makeToken(shop)}`)
    expect(s.getBacklinks(shop)[0].phrase).toBe('grab at')
    await syncOnce(s, link)
    await labeler.run()
    await syncOnce(s, link)
    expect(s.getBacklinks(shop)[0].phrase).toBe('buy at')
    expect(s.getBacklinks(sam)).toHaveLength(0)
    // The next call is told which relations are already in use.
    expect(calls.at(-1)!.vocabulary).toContain('buy at')
  })

  it('skips deleted lines and stays within the daily limit', async () => {
    const { labeler, calls, link } = setup(() => 'with', { maxCallsPerDay: 1, batch: 1 })
    const s = await makeStore()
    const pad = s.createPad('P')
    const sam = s.createNode('person', 'Sam')
    const gone = s.createChild(pad, undefined, { text: `with ${makeToken(sam)}` })
    s.deleteSubtree(gone)
    s.createChild(pad, undefined, { text: `lunch with ${makeToken(sam)}` })
    s.createChild(pad, undefined, { text: `call ${makeToken(sam)}` })
    await syncOnce(s, link)
    expect(labeler.pending(10)).toHaveLength(2)
    await labeler.run()
    labeler.stop()
    expect(calls).toHaveLength(1)
    expect(labeler.pending(10)).toHaveLength(1)
  })
})
