import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import { wrapOo1 } from '../src/db/sql'
import { Store } from '../src/db/store'

let sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>> | undefined

/** A Store over a fresh in-memory database, with a deterministic clock. */
export async function makeStore(): Promise<Store> {
  sqlite3 ??= await sqlite3InitModule()
  const db = new sqlite3.oo1.DB(':memory:', 'c')
  let t = 1_700_000_000_000
  return new Store(wrapOo1(db), { now: () => ++t })
}

/** Compact outline of a subtree: ["a", ["b", "c"]] style, using text. */
export function shape(store: Store, rootId: string): unknown[] {
  const walk = (id: string): unknown[] => {
    const out: unknown[] = []
    for (const c of store.getChildren(id)) {
      out.push(c.text)
      const kids = walk(c.id)
      if (kids.length) out.push(kids)
    }
    return out
  }
  return walk(rootId)
}
