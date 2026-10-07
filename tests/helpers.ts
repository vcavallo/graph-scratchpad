import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import { wrapOo1, type SqlDb } from '../src/db/sql'
import { Store, type WelcomeLine } from '../src/db/store'

let sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>> | undefined

/** A fresh, empty in-memory database (no schema yet). */
export async function makeDb(): Promise<SqlDb> {
  sqlite3 ??= await sqlite3InitModule()
  return wrapOo1(new sqlite3.oo1.DB(':memory:', 'c'))
}

/**
 * A Store over a database (fresh by default) with a deterministic clock that
 * ticks 1 ms per reading, starting at `start`.
 */
export async function makeStore(
  opts: { db?: SqlDb; start?: number; welcome?: WelcomeLine[]; welcomeIntro?: WelcomeLine[] } = {},
): Promise<Store> {
  let t = opts.start ?? 1_700_000_000_000
  return new Store(opts.db ?? (await makeDb()), { now: () => ++t, welcome: opts.welcome, welcomeIntro: opts.welcomeIntro })
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
