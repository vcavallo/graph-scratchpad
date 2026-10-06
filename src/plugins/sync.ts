// How sync reaches its server. This is the open-source default: the sync
// server on the same site (server/serve.mjs's /api/sync), when there is one.
//
// A build of the app can swap this module for its own (a Vite alias for
// '@/plugins/sync'), to sync with a server elsewhere, sign its requests, or
// wrap what's sent; and swap plugins/SyncSettings.vue for the screen that sets
// it up. It runs in the database worker.

import type { SyncRequest, SyncResponse, Transport } from '@/db/sync'

export interface SyncServerInfo {
  /** Shown in Settings. */
  name: string
  /** How many lines the server has (a new device joining one with data drops its welcome pad). */
  nodes: number
  /** The model labelling links on the server, if any. */
  labels?: string
}

export interface SyncConnection {
  /** Ask after the server: its details, or null when there isn't one. Throws when unreachable. */
  probe(): Promise<SyncServerInfo | null>
  /** One sync round trip. */
  send: Transport
  /** Where the server announces changes (server-sent events), if it does. */
  events?: string
}

export interface SyncPlugin {
  /** The connection to sync over, or null for none (nothing set up yet). Asked again on reconnect. */
  connect(): Promise<SyncConnection | null>
  /**
   * A message from the page (the build's own Settings screen), answered with
   * anything structured-cloneable. `reconnect` makes sync ask `connect` again.
   */
  message?(msg: unknown, ctx: { reconnect(): Promise<void> }): Promise<unknown>
}

const TIMEOUT = 30_000

/** Sync with a server at `endpoint` on this site, as server/serve.mjs provides. */
export function sameSiteConnection(endpoint = '/api/sync'): SyncConnection {
  const url = new URL(endpoint, self.location.origin).href
  return {
    async probe() {
      const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(8000) })
      const body = res.ok ? await res.json().catch(() => null) : null
      if (!body?.ok) return null
      return { name: String(body.name ?? ''), nodes: Number(body.nodes) || 0, labels: String(body.relations?.model ?? '') }
    },
    async send(req: SyncRequest): Promise<SyncResponse> {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
        cache: 'no-store',
        signal: AbortSignal.timeout(TIMEOUT),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok || !body || typeof body.epoch !== 'string') {
        throw new Error(body?.error ?? `The sync server answered ${res.status}`)
      }
      return body as SyncResponse
    },
    events: `${url}/events`,
  }
}

export const syncPlugin: SyncPlugin = {
  connect: async () => sameSiteConnection(),
}
