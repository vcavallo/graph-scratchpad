// A minimal synchronous SQL interface. The query logic (store.ts) only talks
// to this, so it runs unchanged in the browser worker (OPFS) and in Node tests
// (in-memory). The SQLite-specific bootstrap lives in worker.ts / tests.

export type Bind = readonly (string | number | null)[] | Record<string, string | number | null>
export type Row = Record<string, unknown>

export interface SqlDb {
  exec(sql: string, bind?: Bind): void
  all<T = Row>(sql: string, bind?: Bind): T[]
  get<T = Row>(sql: string, bind?: Bind): T | undefined
  /** Run fn in a transaction. Nested calls join the outer transaction. */
  tx<T>(fn: () => T): T
  /** Total rows changed since the connection opened. */
  totalChanges(): number
  close(): void
}

/** Structural subset of sqlite-wasm's oo1.DB that we rely on. */
export interface Oo1Like {
  // oo1.DB.exec is heavily overloaded; we only ever call the options form.
  exec(opts: any): unknown
  changes(total?: boolean, sixtyFour?: boolean): number | bigint
  close(): void
}

export function wrapOo1(db: Oo1Like): SqlDb {
  let depth = 0
  const all = <T>(sql: string, bind?: Bind): T[] =>
    db.exec({ sql, bind, rowMode: 'object', returnValue: 'resultRows' }) as T[]

  const api: SqlDb = {
    exec(sql, bind) {
      db.exec({ sql, bind })
    },
    all,
    get<T>(sql: string, bind?: Bind) {
      return all<T>(sql, bind)[0]
    },
    tx<T>(fn: () => T): T {
      if (depth > 0) {
        depth++
        try {
          return fn()
        } finally {
          depth--
        }
      }
      db.exec({ sql: 'BEGIN IMMEDIATE' })
      depth = 1
      try {
        const result = fn()
        db.exec({ sql: 'COMMIT' })
        return result
      } catch (e) {
        try {
          db.exec({ sql: 'ROLLBACK' })
        } catch {
          // Transaction may already be gone (e.g. SQLITE_FULL); nothing to do.
        }
        throw e
      } finally {
        depth = 0
      }
    },
    totalChanges() {
      return Number(db.changes(true))
    },
    close() {
      db.close()
    },
  }
  return api
}
