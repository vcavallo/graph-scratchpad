// Web Worker that owns the SQLite database. The browser-specific bootstrap
// (sqlite-wasm + opfs-sahpool) lives here; all query logic is in store.ts.

import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import { wrapOo1 } from './sql'
import { Store, StoreError } from './store'
import type { DbInfo } from './types'
import type { WorkerRequest, WorkerMessage } from './protocol'
import { SyncRunner } from './syncRunner'

interface WorkerScope {
  postMessage(msg: WorkerMessage): void
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null
  navigator: Navigator
}
const scope = globalThis as unknown as WorkerScope

const DB_FILE = '/scratchpad.sqlite3'
const LOCK_NAME = 'graph-scratchpad-db'

let store: Store | null = null
let storage: DbInfo['storage'] = 'memory'
let sqliteVersion = ''
let sync: SyncRunner | null = null
const queue: WorkerRequest[] = []

const METHODS = new Set(Object.getOwnPropertyNames(Store.prototype).filter((n) => n !== 'constructor'))

scope.onmessage = (e) => {
  if (!store) queue.push(e.data)
  else handle(e.data)
}

/** Requests about sync itself, answered by the runner rather than the Store. */
const SYNC_CALLS: Record<string, (args: unknown[]) => Promise<unknown>> = {
  syncStatus: async () => ({ ...sync!.status }),
  syncNow: async () => {
    await sync!.run()
    return { ...sync!.status }
  },
  syncEnable: (args) => sync!.setEnabled(args[0] === true),
  syncReady: () => sync!.ready(),
}

function handle(req: WorkerRequest): void {
  const s = store!
  const syncCall = SYNC_CALLS[req.method]
  if (syncCall) {
    syncCall(req.args).then(
      (result) => scope.postMessage({ type: 'result', id: req.id, ok: true, result, changed: false }),
      (err: Error) =>
        scope.postMessage({ type: 'result', id: req.id, ok: false, error: { name: err.name, message: err.message } }),
    )
    return
  }
  if (req.method === 'dbInfo') {
    const info: DbInfo = { ...s.info(), storage, sqliteVersion }
    scope.postMessage({ type: 'result', id: req.id, ok: true, result: info, changed: false })
    return
  }
  if (!METHODS.has(req.method)) {
    scope.postMessage({
      type: 'result',
      id: req.id,
      ok: false,
      error: { name: 'Error', message: `Unknown method ${req.method}`, code: 'unknown_method' },
    })
    return
  }
  const before = s.db.totalChanges()
  try {
    const fn = (s as unknown as Record<string, (...a: unknown[]) => unknown>)[req.method]
    const result = fn.apply(s, req.args)
    const changed = s.db.totalChanges() !== before
    scope.postMessage({ type: 'result', id: req.id, ok: true, result, changed })
    if (changed && !req.method.startsWith('sync')) sync?.schedule()
  } catch (err) {
    const e = err as Error
    scope.postMessage({
      type: 'result',
      id: req.id,
      ok: false,
      error: { name: e.name, message: e.message, code: err instanceof StoreError ? err.code : undefined },
    })
  }
}

async function open(): Promise<void> {
  const sqlite3 = await sqlite3InitModule()
  sqliteVersion = sqlite3.version.libVersion
  let reason: string | undefined
  let db
  try {
    const pool = await sqlite3.installOpfsSAHPoolVfs({ directory: '.graph-scratchpad' })
    db = new pool.OpfsSAHPoolDb(DB_FILE)
    storage = 'opfs-sahpool'
  } catch (err) {
    reason = err instanceof Error ? err.message : String(err)
    db = new sqlite3.oo1.DB(':memory:', 'c')
    storage = 'memory'
  }
  store = new Store(wrapOo1(db))
  sync = new SyncRunner(store, new URL('/api/sync', self.location.origin).href, (status, changed) => {
    scope.postMessage({ type: 'sync', status })
    if (changed) scope.postMessage({ type: 'changed' })
  })
  scope.postMessage({ type: 'ready', storage, reason, sqliteVersion })
  for (const req of queue.splice(0)) handle(req)
  // Only a database that persists syncs; an in-memory fallback would push nothing useful.
  if (storage === 'opfs-sahpool') void sync.start()
  else sync.status.checked = true
}

async function start(): Promise<void> {
  try {
    const locks = scope.navigator.locks
    if (!locks) {
      await open()
      return
    }
    // opfs-sahpool needs exclusive file handles, so only one tab can have the
    // database open. A second tab waits until the first one goes away.
    await locks.request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
      if (lock) {
        await open()
        await new Promise(() => {}) // hold the lock for the life of the worker
      }
    })
    scope.postMessage({ type: 'waiting' })
    await locks.request(LOCK_NAME, async () => {
      await open()
      await new Promise(() => {})
    })
  } catch (err) {
    const e = err as Error
    scope.postMessage({ type: 'fatal', message: `${e.name}: ${e.message}` })
  }
}

start()
