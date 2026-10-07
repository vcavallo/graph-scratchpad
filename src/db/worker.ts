// Web Worker that owns the SQLite database. The browser-specific bootstrap
// (sqlite-wasm + opfs-sahpool) lives here; all query logic is in store.ts.

import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import { wrapOo1 } from './sql'
import { Store, StoreError } from './store'
import type { DbInfo } from './types'
import type { WorkerRequest, WorkerMessage } from './protocol'
import { SyncRunner } from './syncRunner'
import { syncPlugin } from '@/plugins/sync'

interface WorkerScope {
  postMessage(msg: WorkerMessage): void
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null
  navigator: Navigator
}
const scope = globalThis as unknown as WorkerScope

const DB_FILE = '/scratchpad.sqlite3'
const LOCK_NAME = 'graph-scratchpad-db'
const POOL_DIR = '.graph-scratchpad'
/** sqlite-wasm keeps the pool's files in this subdirectory. */
const POOL_FILES_DIR = '.opaque'

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
  // The sync plugin's own messages (its Settings screen signing in, say).
  syncMessage: async (args) =>
    syncPlugin.message ? syncPlugin.message(args[0], { reconnect: async () => void (await sync!.reconnect()) }) : null,
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Worker-only OPFS API (not in the DOM typings).
type SyncCapableFile = FileSystemFileHandle & { createSyncAccessHandle(): Promise<{ close(): void }> }

/**
 * opfs-sahpool needs an exclusive handle on every file in its pool. Right
 * after a reload, the previous page's worker may still be letting go of them
 * (the Web Lock can be released first). Wait until each file can be opened.
 */
async function waitForPoolFiles(timeoutMs = 10_000): Promise<void> {
  let dir: FileSystemDirectoryHandle
  try {
    const root = await navigator.storage.getDirectory()
    dir = await (await root.getDirectoryHandle(POOL_DIR)).getDirectoryHandle(POOL_FILES_DIR)
  } catch {
    return // first run: nothing there yet
  }
  const end = Date.now() + timeoutMs
  for (let attempt = 0; ; attempt++) {
    const opened: { close(): void }[] = []
    try {
      for await (const h of (dir as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
        if (h.kind === 'file') opened.push(await (h as SyncCapableFile).createSyncAccessHandle())
      }
      return
    } catch (err) {
      if (Date.now() > end) throw err
      await sleep(Math.min(100 * 2 ** attempt, 1000))
    } finally {
      for (const h of opened) h.close()
    }
  }
}

/**
 * When installOpfsSAHPoolVfs fails it calls removeVfs(), which deletes the
 * pool directory, i.e. the database. While it runs, refuse to delete the pool
 * directories (it only removes a scratch file of its own on the way to
 * success), so a failed open leaves the data where it is.
 */
async function withoutDeletes<T>(fn: () => Promise<T>): Promise<T> {
  const proto = FileSystemDirectoryHandle.prototype
  const original = proto.removeEntry
  proto.removeEntry = function (this: FileSystemDirectoryHandle, name: string, opts?: FileSystemRemoveOptions) {
    if (name === POOL_DIR || name === POOL_FILES_DIR) {
      return Promise.reject(new DOMException('Not while opening the database', 'NoModificationAllowedError'))
    }
    return original.call(this, name, opts)
  }
  try {
    return await fn()
  } finally {
    proto.removeEntry = original
  }
}

async function openPool(sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>>) {
  await waitForPoolFiles()
  return withoutDeletes(async () => {
    let last: unknown
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await sleep(250 * 2 ** attempt)
      try {
        // forceReinitIfPreviouslyFailed: without it a failed attempt is cached and every retry fails too.
        const opts = { directory: POOL_DIR, forceReinitIfPreviouslyFailed: attempt > 0 }
        return await sqlite3.installOpfsSAHPoolVfs(opts as Parameters<typeof sqlite3.installOpfsSAHPoolVfs>[0])
      } catch (err) {
        last = err
      }
    }
    throw last
  })
}

async function open(): Promise<void> {
  const sqlite3 = await sqlite3InitModule()
  sqliteVersion = sqlite3.version.libVersion
  let reason: string | undefined
  let db
  try {
    const pool = await openPool(sqlite3)
    db = new pool.OpfsSAHPoolDb(DB_FILE)
    storage = 'opfs-sahpool'
  } catch (err) {
    reason = err instanceof Error ? err.message : String(err)
    db = new sqlite3.oo1.DB(':memory:', 'c')
    storage = 'memory'
  }
  store = new Store(wrapOo1(db), { welcome: syncPlugin.welcome, welcomeIntro: syncPlugin.welcomeIntro })
  sync = new SyncRunner(store, () => syncPlugin.connect(), (status, changed) => {
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
