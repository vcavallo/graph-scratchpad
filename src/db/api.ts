// Typed async client for the database worker. Components call `api.xxx(...)`,
// which posts a message to the worker and resolves with the Store method's
// return value. No SQL outside src/db.

import { reactive } from 'vue'
import type { Store } from './store'
import type { DbInfo } from './types'
import type { SyncStatus, WorkerMessage, WorkerError } from './protocol'

type Fn = (...args: never[]) => unknown
type Remote<T> = {
  [K in keyof T as T[K] extends Fn ? K : never]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<R>
    : never
}
export type Api = Remote<Store> & {
  dbInfo(): Promise<DbInfo>
  syncStatus(): Promise<SyncStatus>
  /** Sync now (or wait for the run in progress). */
  syncNow(): Promise<SyncStatus>
  syncEnable(on: boolean): Promise<SyncStatus>
  /** Resolves after the first sync attempt (or a few seconds, whichever is first). */
  syncReady(): Promise<SyncStatus>
}

export class ApiError extends Error {
  code?: string
  constructor(e: WorkerError) {
    super(e.message)
    this.name = e.name
    this.code = e.code
  }
}

export const dbState = reactive({
  status: 'loading' as 'loading' | 'waiting' | 'ready' | 'fatal',
  storage: null as DbInfo['storage'] | null,
  /** Why we fell back to an in-memory database, if we did. */
  reason: '' as string,
  error: '' as string,
  /** Bumped after every write that changed rows; views watch it to refetch. */
  version: 0,
  /** Bumped when a write is sent; lets views drop reads that raced a write. */
  writesSent: 0,
  /** Writes sent but not yet answered. */
  writesPending: 0,
})

/** Latest sync status from the worker. */
export const syncState = reactive<SyncStatus>({
  available: false,
  checked: false,
  server: '',
  enabled: false,
  state: 'off',
  lastSync: null,
  error: '',
  pending: 0,
  cursor: 0,
  autoEnabled: false,
})

// Sync calls don't count as writes: a sync that merges something reports it with a 'changed' message.
const READ_PREFIXES = ['get', 'list', 'search', 'info', 'export', 'dbInfo', 'sync']
const isRead = (method: string) => READ_PREFIXES.some((p) => method.startsWith(p))

let worker: Worker | null = null
let seq = 0
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()

function ensureWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
    const msg = e.data
    switch (msg.type) {
      case 'ready':
        dbState.status = 'ready'
        dbState.storage = msg.storage
        dbState.reason = msg.reason ?? ''
        break
      case 'waiting':
        dbState.status = 'waiting'
        break
      case 'fatal':
        dbState.status = 'fatal'
        dbState.error = msg.message
        break
      case 'sync':
        Object.assign(syncState, msg.status)
        break
      case 'changed':
        dbState.version++
        break
      case 'result': {
        const p = pending.get(msg.id)
        if (!p) return
        pending.delete(msg.id)
        if (msg.ok) {
          if (msg.changed) dbState.version++
          p.resolve(msg.result)
        } else {
          p.reject(new ApiError(msg.error))
        }
      }
    }
  }
  worker.onerror = (e) => {
    dbState.status = 'fatal'
    dbState.error = e.message || 'The database worker failed to start.'
  }
  return worker
}

function call(method: string, args: unknown[]): Promise<unknown> {
  const w = ensureWorker()
  const id = ++seq
  const write = !isRead(method)
  if (write) {
    dbState.writesSent++
    dbState.writesPending++
  }
  return new Promise((resolve, reject) => {
    const settle = <T>(fn: (v: T) => void) => (v: T) => {
      if (write) dbState.writesPending--
      fn(v)
    }
    pending.set(id, { resolve: settle(resolve), reject: settle(reject) })
    // Vue reactive proxies can't be structured-cloned; send plain copies.
    w.postMessage({ id, method, args: args.map(toPlain) })
  })
}

function toPlain(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v
  return JSON.parse(JSON.stringify(v))
}

export const api = new Proxy({} as Api, {
  get(_t, method: string) {
    return (...args: unknown[]) => call(method, args)
  },
})

/** Start the worker early so the database is warm by the time a view asks. */
export function startDb(): void {
  ensureWorker()
}
