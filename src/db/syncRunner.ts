// Background sync, run inside the database worker. Finds out whether this
// site has a sync server, then syncs shortly after local writes, when the page
// asks (app opened, back online, another device changed something), and on
// retry after failures. The app never waits for it.

import type { Store } from './store'
import type { SyncStatus } from './protocol'
import { syncOnce, type SyncRequest, type SyncResponse } from './sync'

const REQUEST_TIMEOUT = 30_000
const MAX_RETRY = 5 * 60_000

export class SyncRunner {
  status: SyncStatus = {
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
  }
  #running: Promise<void> | null = null
  #again = false
  #timer: ReturnType<typeof setTimeout> | undefined
  #retryMs = 0
  #started: Promise<void> | null = null
  #serverHasData = false

  constructor(
    private store: Store,
    private endpoint: string,
    private report: (status: SyncStatus, changed: boolean) => void,
  ) {}

  #set(patch: Partial<SyncStatus>, changed = false): void {
    const info = this.store.syncInfo()
    Object.assign(this.status, { pending: info.pending, cursor: info.cursor }, patch)
    this.report({ ...this.status }, changed)
  }

  /** Look for a server; on first contact, switch sync on. Resolves after the first sync attempt. */
  start(): Promise<void> {
    this.#started ??= (async () => {
      const info = this.store.syncInfo()
      let wiped = false
      try {
        const res = await fetch(this.endpoint, { cache: 'no-store', signal: AbortSignal.timeout(8000) })
        const body = res.ok ? await res.json() : null
        if (body?.ok) {
          this.status.available = true
          this.status.server = String(body.name ?? '')
          this.#serverHasData = Number(body.nodes) > 0
          if (info.enabled === null) {
            // Progressive enhancement: a site with a sync server syncs, unless turned off here.
            this.store.syncSetEnabled(true)
            this.status.autoEnabled = true
            if (this.#serverHasData) wiped = this.store.syncPrepareJoin()
          }
        }
      } catch {
        // Offline or no server. If sync was on before, keep trying below.
      }
      this.status.checked = true
      this.status.enabled = this.store.syncInfo().enabled === true && (this.status.available || info.enabled === true)
      this.#set({ state: this.status.enabled ? 'idle' : 'off' }, wiped)
      if (this.status.enabled) await this.run()
    })()
    return this.#started
  }

  /** Wait for the first sync (bounded), e.g. before deciding to show the welcome pad. */
  async ready(timeoutMs = 3000): Promise<SyncStatus> {
    await Promise.race([this.start(), new Promise((r) => setTimeout(r, timeoutMs))])
    return { ...this.status }
  }

  /** A local write happened: sync soon (writes in quick succession share one run). */
  schedule(delay = 1200): void {
    if (!this.status.enabled) return
    clearTimeout(this.#timer)
    this.#timer = setTimeout(() => void this.run(), delay)
    this.#set({})
  }

  async run(): Promise<void> {
    if (!this.status.enabled) return
    if (this.#running) {
      this.#again = true
      return this.#running
    }
    clearTimeout(this.#timer)
    this.#running = (async () => {
      const before = this.store.db.totalChanges()
      this.#set({ state: 'syncing' })
      try {
        if (!this.status.available) {
          // Sync was on but the server wasn't reachable at startup: look again.
          const res = await fetch(this.endpoint, { cache: 'no-store', signal: AbortSignal.timeout(8000) })
          const body = res.ok ? await res.json() : null
          if (!body?.ok) throw new Error('This site has no sync server')
          this.status.available = true
          this.status.server = String(body.name ?? '')
        }
        await syncOnce(this.store, (req) => this.#send(req))
        this.#retryMs = 0
        this.#set({ state: 'idle', lastSync: Date.now(), error: '' }, this.store.db.totalChanges() !== before)
      } catch (e) {
        const offline = e instanceof TypeError || (e instanceof DOMException && e.name === 'TimeoutError')
        this.#retryMs = Math.min(this.#retryMs ? this.#retryMs * 2 : 5000, MAX_RETRY)
        this.#set(
          { state: offline ? 'offline' : 'error', error: offline ? '' : e instanceof Error ? e.message : String(e) },
          this.store.db.totalChanges() !== before,
        )
        this.#timer = setTimeout(() => void this.run(), this.#retryMs)
      }
    })()
    try {
      await this.#running
    } finally {
      this.#running = null
    }
    if (this.#again) {
      this.#again = false
      await this.run()
    }
  }

  async setEnabled(on: boolean): Promise<SyncStatus> {
    this.store.syncSetEnabled(on)
    this.status.enabled = on
    this.status.autoEnabled = false
    if (!on) {
      clearTimeout(this.#timer)
      this.#set({ state: 'off', error: '' })
      return { ...this.status }
    }
    let wiped = false
    if (this.store.syncInfo().epoch === null && this.#serverHasData) wiped = this.store.syncPrepareJoin()
    this.#set({ state: 'idle' }, wiped)
    await this.run()
    return { ...this.status }
  }

  async #send(req: SyncRequest): Promise<SyncResponse> {
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    })
    const body = await res.json().catch(() => null)
    if (!res.ok || !body || typeof body.epoch !== 'string') {
      throw new Error(body?.error ?? `The sync server answered ${res.status}`)
    }
    return body as SyncResponse
  }
}
