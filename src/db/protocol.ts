// Messages between the main thread (api.ts) and the database worker.

import type { DbInfo } from './types'

export interface WorkerRequest {
  id: number
  method: string
  args: unknown[]
}

export interface WorkerError {
  name: string
  message: string
  code?: string
}

/** A message from the sync server for the whole app, as a banner (a plan running out, say). */
export interface SyncNotice {
  text: string
  /** A page in the app to go to (a route, like '/settings'), with the button's label. */
  to?: string
  action?: string
}

/** What the page shows about sync (Settings, and the first-run note). */
export interface SyncStatus {
  /** This site has a sync server. */
  available: boolean
  /** We've looked. */
  checked: boolean
  /** The server's name (its hostname). */
  server: string
  enabled: boolean
  state: 'off' | 'idle' | 'syncing' | 'offline' | 'error'
  lastSync: number | null
  error: string
  /** Nodes with changes not yet sent. */
  pending: number
  /** Server sequence number we've pulled up to (compared with change notifications). */
  cursor: number
  /** Where the server announces changes (server-sent events); empty when it doesn't. */
  events: string
  /** Something to show across the app, from the sync connection (plugins/sync.ts), or null. */
  notice: SyncNotice | null
  /** Sync switched itself on in this session because the site offers it. */
  autoEnabled: boolean
  /** The model the server labels links with, if any. */
  labels: string
}

export type WorkerMessage =
  | { type: 'ready'; storage: DbInfo['storage']; reason?: string; sqliteVersion: string }
  | { type: 'waiting' }
  | { type: 'fatal'; message: string }
  | { type: 'result'; id: number; ok: true; result: unknown; changed: boolean }
  | { type: 'result'; id: number; ok: false; error: WorkerError }
  | { type: 'sync'; status: SyncStatus }
  /** Data changed without a request from the page (sync merged something in). */
  | { type: 'changed' }
