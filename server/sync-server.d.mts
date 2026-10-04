// Types for sync-server.mjs (plain JS so it runs without a build step).
import type { SyncRequest, SyncResponse } from '../src/db/sync'

export class SyncError extends Error {
  status: number
}

export class SyncServer {
  constructor(db: unknown, opts?: { uuid?: () => string })
  readonly epoch: string
  readonly seq: number
  info(): { epoch: string; seq: number; nodes: number; fields: number }
  onChange(fn: (seq: number) => void): () => void
  sync(req: SyncRequest & { limit?: number }): SyncResponse
  backup(path: string): void
}
