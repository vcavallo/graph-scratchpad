// Link labels by a language model, on the server. Devices guess a relation
// for each link from its wording (src/lib/relations.ts); this refines it with
// judgement: "pick up teflon tape at [[Hardware store]]" and "get hose clamps
// at [[Hardware store]]" both become "buy at", "remind [[Sam]] to bring the
// ladder" becomes "ask". Results go back to the devices through sync, as a
// 'rels' field on the line's node: { [linkedId]: { r: relation or null, h: hash
// of the text it was read from } }. Devices use a label only while the text
// still hashes the same, and fall back to their own guess otherwise.
//
// The classifier is pluggable (Claude Haiku by default). Nothing waits on it:
// it runs a few seconds after lines change, in batches, within a daily cap.

const TOKEN = /\[\[([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\]\]/g
const SERVER_DEVICE = 'server'
/** Must match NO_RELATION_ID in src/db/types.ts. */
const NO_RELATION_ID = '00000000-0000-4000-8000-00000000a11a'

/** FNV-1a, base 36. Must match src/lib/textHash.ts. */
export function textHash(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36)
}

/** A relation as we store it: lowercase, one to four plain words; anything else is no relation. */
export function cleanRelation(r) {
  if (typeof r !== 'string') return null
  const s = r.toLowerCase().replace(/[^a-z' ]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!s || s === 'null' || s === 'none' || s.split(' ').length > 4) return null
  return s
}

const tokens = (text) => [...new Set([...text.matchAll(TOKEN)].map((m) => m[1].toLowerCase()))]

export class RelationLabeler {
  #sync
  #classify
  #opts
  #timer = null
  #running = false
  #writing = false
  #off = null
  #failures = 0
  #wall = 0
  #count = 0
  #stats = { calls: 0, labelled: 0, inputTokens: 0, outputTokens: 0, day: '', callsToday: 0, lastError: '' }

  /**
   * sync: the SyncServer. classify(items, vocabulary) resolves to
   * { labels: [{ id, relation }], usage?: { input_tokens, output_tokens } }.
   */
  constructor(sync, classify, opts = {}) {
    this.#sync = sync
    this.#classify = classify
    this.#opts = { model: 'model', batch: 40, delayMs: 4000, maxCallsPerDay: 300, log: console.log, ...opts }
    // Our clock never goes behind labels written before.
    const prev = /^([0-9a-z]{9})-([0-9a-z]{4})-/.exec(sync.maxHlc('rels') ?? '')
    if (prev) {
      this.#wall = parseInt(prev[1], 36)
      this.#count = parseInt(prev[2], 36)
    }
  }

  /** Label everything that needs it now, then again whenever lines change. */
  start() {
    this.#off = this.#sync.onChange(() => {
      if (!this.#writing) this.schedule()
    })
    this.schedule(1000)
    return this
  }

  stop() {
    this.#off?.()
    clearTimeout(this.#timer)
  }

  schedule(ms = this.#opts.delayMs) {
    clearTimeout(this.#timer)
    this.#timer = setTimeout(() => void this.run(), ms)
    this.#timer.unref?.()
  }

  stats() {
    return { model: this.#opts.model, ...this.#stats, pending: this.pending(10_000).length }
  }

  #tick() {
    const t = Date.now()
    if (t > this.#wall) {
      this.#wall = t
      this.#count = 0
    } else this.#count++
    return `${this.#wall.toString(36).padStart(9, '0')}-${this.#count.toString(36).padStart(4, '0')}-${SERVER_DEVICE}`
  }

  /** Short label for a node (its text, links replaced by their targets' text). */
  #label(id) {
    const text = this.#sync.field(id, 'text')
    if (typeof text !== 'string') return '?'
    const flat = text.replace(TOKEN, (_m, t) => {
      const inner = this.#sync.field(t.toLowerCase(), 'text')
      return typeof inner === 'string' ? inner.replace(TOKEN, '…') : '…'
    })
    const l = flat.replace(/\s+/g, ' ').trim() || 'Untitled'
    return l.length > 60 ? l.slice(0, 59) + '…' : l
  }

  /** Links whose label is missing or was read from older text. */
  pending(limit = this.#opts.batch) {
    const out = []
    for (const [src, text] of this.#sync.allOf('text')) {
      if (typeof text !== 'string' || !text.includes('[[')) continue
      if (this.#sync.field(src, 'deleted_at') != null || this.#sync.field(src, 'purged')) continue
      const rels = this.#sync.field(src, 'rels') ?? {}
      const h = textHash(text)
      for (const dst of tokens(text)) {
        if (dst === src || rels[dst]?.h === h) continue
        out.push({ src, dst, text, h })
        if (out.length >= limit) return out
      }
    }
    return out
  }

  /**
   * What the model should reuse: the relations you kept (first), then labels
   * in use, most common first; the other ways you write your relations; and
   * the phrases you said aren't relations.
   */
  vocabulary(max = 40) {
    const live = (id) => this.#sync.field(id, 'deleted_at') == null && !this.#sync.field(id, 'purged')
    const relations = new Map() // id → name
    for (const [id, kind] of this.#sync.allOf('kind')) {
      const text = this.#sync.field(id, 'text')
      if (kind === 'relation' && live(id) && typeof text === 'string' && text.trim()) relations.set(id, text.trim().toLowerCase())
    }
    const sameAs = {}
    const notRelations = []
    for (const [id, pos] of this.#sync.allOf('pos')) {
      const text = this.#sync.field(id, 'text')
      if (!pos?.p || !relations.has(pos.p) || !live(id) || typeof text !== 'string' || !text.trim()) continue
      if (pos.p === NO_RELATION_ID) notRelations.push(text.trim().toLowerCase())
      else sameAs[text.trim().toLowerCase()] = relations.get(pos.p)
    }
    const kept = [...relations].filter(([id]) => id !== NO_RELATION_ID).map(([, name]) => name)
    const counts = new Map()
    for (const [, rels] of this.#sync.allOf('rels')) {
      for (const v of Object.values(rels ?? {})) if (v?.r) counts.set(v.r, (counts.get(v.r) ?? 0) + 1)
    }
    const used = [...counts]
      .sort((a, b) => b[1] - a[1])
      .map(([r]) => sameAs[r] ?? r)
      .filter((r) => !kept.includes(r) && !notRelations.includes(r))
    const relationsList = [...new Set([...kept, ...used])].slice(0, max)
    return { relations: relationsList, sameAs, notRelations }
  }

  /** What the model sees for one link: the line with that link marked ⟦like this⟧. */
  #item(p, i) {
    const line = p.text
      .replace(TOKEN, (_m, t) => (t.toLowerCase() === p.dst ? `⟦${this.#label(p.dst)}⟧` : this.#label(t.toLowerCase())))
      .replace(/\s+/g, ' ')
      .trim()
    // What it is: its kind of context ("Rooms", "Places"), or for older nodes their place/person kind.
    const cat = this.#sync.field(p.dst, 'category')
    const catName = typeof cat === 'string' ? this.#sync.field(cat, 'text') : undefined
    const kind = typeof catName === 'string' && catName.trim() ? catName.trim() : (this.#sync.field(p.dst, 'kind') ?? 'item')
    const parent = this.#sync.field(p.src, 'pos')?.p
    return { id: String(i), line, linked: kind === 'item' ? 'item or list' : kind, ...(parent ? { under: this.#label(parent) } : {}) }
  }

  async run() {
    if (this.#running) return this.schedule()
    this.#running = true
    try {
      for (;;) {
        const day = new Date().toISOString().slice(0, 10)
        if (this.#stats.day !== day) Object.assign(this.#stats, { day, callsToday: 0 })
        if (this.#stats.callsToday >= this.#opts.maxCallsPerDay) {
          this.#opts.log(`relations: daily limit of ${this.#opts.maxCallsPerDay} calls reached; continuing tomorrow`)
          return this.schedule(60 * 60 * 1000)
        }
        const batch = this.pending(this.#opts.batch)
        if (!batch.length) return
        this.#stats.callsToday++
        this.#stats.calls++
        const { labels, usage } = await this.#classify(
          batch.map((p, i) => this.#item(p, i)),
          this.vocabulary(),
        )
        this.#stats.inputTokens += usage?.input_tokens ?? 0
        this.#stats.outputTokens += usage?.output_tokens ?? 0
        const byId = new Map((labels ?? []).map((l) => [String(l.id), cleanRelation(l.relation)]))
        // One 'rels' write per line, merging with labels it already has for its other links.
        const bySrc = new Map()
        batch.forEach((p, i) => {
          if (!byId.has(String(i))) return // the model skipped it: try again next time
          if (!bySrc.has(p.src)) bySrc.set(p.src, [])
          bySrc.get(p.src).push({ ...p, r: byId.get(String(i)) })
        })
        if (!bySrc.size) throw new Error('The model returned no labels')
        const writes = []
        for (const [src, done] of bySrc) {
          const text = done[0].text
          const keep = new Set(tokens(text))
          const rels = Object.fromEntries(Object.entries(this.#sync.field(src, 'rels') ?? {}).filter(([d]) => keep.has(d)))
          for (const d of done) rels[d.dst] = { r: d.r, h: d.h }
          writes.push({ n: src, f: 'rels', v: rels, h: this.#tick() })
        }
        this.#writing = true
        try {
          this.#sync.write(writes, SERVER_DEVICE)
        } finally {
          this.#writing = false
        }
        const n = [...bySrc.values()].reduce((a, d) => a + d.length, 0)
        this.#stats.labelled += n
        this.#stats.lastError = ''
        this.#failures = 0
        this.#opts.log(`relations: labelled ${n} link${n === 1 ? '' : 's'} (${this.#stats.callsToday} calls today)`)
      }
    } catch (e) {
      this.#failures++
      this.#stats.lastError = e instanceof Error ? e.message : String(e)
      const wait = Math.min(30_000 * 2 ** (this.#failures - 1), 30 * 60_000)
      this.#opts.log(`relations: ${this.#stats.lastError}; retrying in ${Math.round(wait / 1000)} s`)
      this.schedule(wait)
    } finally {
      this.#running = false
    }
  }
}

// --------------------------------------------------------------- Claude

const SYSTEM = `You label the links in one person's to-do and notes outliner.

Each item is a line containing one marked link, written ⟦like this⟧, to a place, a person, a list, or another item. "under" is the line the item sits under, for context.

For each item, name the relationship the line expresses toward the linked thing, the way this person would say it: a short lowercase phrase of one to three words, usually a verb, a verb plus a preposition, or a preposition. Examples: "buy at", "waiting on", "ask", "return to", "owes", "with", "about".

- Read the whole line, including the words after the link.
- Name the relationship, not the specific object: "buy 3/4-inch elbows at ⟦Hardware store⟧" is "buy at".
- vocabulary.relations lists the phrases already in use, the person's own first. Reuse one whenever it means the same thing: prefer an existing "buy at" to "get at", "pick up at" or "grab at".
- vocabulary.sameAs maps other wordings to the person's relation: answer with the relation, not the wording.
- vocabulary.notRelations are wordings the person treats as plain mentions: answer null for those.
- If the link is only a mention with no particular relationship, use null.
- Answer for every id.`

const TOOL = {
  name: 'label_links',
  description: 'Record the relation for each link.',
  input_schema: {
    type: 'object',
    properties: {
      labels: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            relation: { type: ['string', 'null'], description: 'Short lowercase phrase, or null for a plain mention.' },
          },
          required: ['id', 'relation'],
        },
      },
    },
    required: ['labels'],
  },
}

export function claudeClassifier({ apiKey, model = 'claude-haiku-4-5-20251001', fetchImpl = globalThis.fetch }) {
  return async (items, vocabulary) => {
    const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        system: SYSTEM,
        tools: [TOOL],
        tool_choice: { type: 'tool', name: TOOL.name },
        messages: [{ role: 'user', content: JSON.stringify({ vocabulary, items }, null, 1) }],
      }),
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`Claude API answered ${res.status}: ${detail.slice(0, 300)}`)
    }
    const json = await res.json()
    const use = json.content?.find((c) => c.type === 'tool_use')
    return { labels: use?.input?.labels ?? [], usage: json.usage }
  }
}
