// The sync round trip, independent of how requests travel (fetch in the
// worker, a direct call in tests). Local-first: the app never waits on this;
// it runs in the background and merges whatever the server has.

import type { SyncChange, SyncInfo } from './types'

export interface SyncRequest {
  device: string
  since: number
  changes: SyncChange[]
}

export interface SyncResponse {
  epoch: string
  cursor: number
  changes: SyncChange[]
  more: boolean
  accepted: number
}

export type Transport = (req: SyncRequest) => Promise<SyncResponse>

/** The parts of the Store that sync uses. */
export interface SyncableStore {
  syncInfo(): SyncInfo
  syncBegin(epoch: string): boolean
  syncCollect(limit?: number): SyncChange[]
  syncAck(changes: Pick<SyncChange, 'n' | 'f' | 'h'>[]): void
  syncApply(changes: SyncChange[], at?: { cursor: number; epoch: string }): number
}

export interface SyncResult {
  /** Fields changed locally by what we pulled. */
  applied: number
  /** Fields sent. */
  pushed: number
  cursor: number
}

/**
 * Push everything unsent and pull everything new, in batches, until both
 * sides are caught up. Changes made while a request is in flight simply go in
 * the next batch (or the next run).
 */
export async function syncOnce(store: SyncableStore, send: Transport, batch = 2000): Promise<SyncResult> {
  let applied = 0
  let pushed = 0
  let cursor = 0
  for (let round = 0; round < 10_000; round++) {
    const info = store.syncInfo()
    const changes = store.syncCollect(batch)
    const res = await send({ device: info.deviceId, since: info.cursor, changes })
    if (res.epoch !== info.epoch) {
      // A server we haven't synced with (or a reset one): start over.
      if (store.syncBegin(res.epoch)) continue
    }
    store.syncAck(changes)
    pushed += changes.length
    applied += store.syncApply(res.changes, { cursor: res.cursor, epoch: res.epoch })
    cursor = res.cursor
    if (changes.length < batch && !res.more) break
  }
  return { applied, pushed, cursor }
}
