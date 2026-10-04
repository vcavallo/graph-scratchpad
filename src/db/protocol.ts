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

export type WorkerMessage =
  | { type: 'ready'; storage: DbInfo['storage']; reason?: string; sqliteVersion: string }
  | { type: 'waiting' }
  | { type: 'fatal'; message: string }
  | { type: 'result'; id: number; ok: true; result: unknown; changed: boolean }
  | { type: 'result'; id: number; ok: false; error: WorkerError }
