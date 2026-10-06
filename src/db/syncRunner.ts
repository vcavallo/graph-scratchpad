// Background sync, run inside the database worker. Finds out whether there's
// a sync server (through the sync plugin: plugins/sync.ts), then syncs shortly
// after local writes, when the page asks (app opened, back online, another
// device changed something), and on retry after failures. The app never waits
// for it.

import type { Store } from './store'
import type { SyncStatus } from './protocol'
import { syncOnce } from './sync'
import type { SyncConnection } from '../plugins/sync'

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
    labels: '',
    events: '',
  }
  #running: Promise<void> | null = null
  #again = false
  #timer: ReturnType<typeof setTimeout> | undefined
  #retryMs = 0
  #started: Promise<void> | null = null
  #serverHasData = false
  #conn: SyncConnection | null = null

  constructor(
    private store: Store,
    private connect: () => Promise<SyncConnection | null>,
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
        this.#conn = await this.connect()
        const server = this.#conn ? await this.#conn.probe() : null
        if (server) {
          this.status.available = true
          this.status.server = server.name
          this.status.labels = server.labels ?? ''
          this.#serverHasData = server.nodes > 0
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
      this.status.events = this.#conn?.events ?? ''
      // No connection (nothing set up): no sync, whatever this device had before.
      this.status.enabled =
        this.#conn !== null && this.store.syncInfo().enabled === true && (this.status.available || info.enabled === true)
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

  /** The sync plugin's setup changed (signed in or out, say): look for the server again. */
  async reconnect(): Promise<SyncStatus> {
    clearTimeout(this.#timer)
    await this.#running?.catch(() => {})
    this.#started = null
    this.#conn = null
    Object.assign(this.status, { available: false, checked: false, server: '', labels: '', error: '', events: '' })
    await this.start()
    return { ...this.status }
  }

  async run(): Promise<void> {
    if (!this.status.enabled || !this.#conn) return
    if (this.#running) {
      this.#again = true
      return this.#running
    }
    clearTimeout(this.#timer)
    this.#running = (async () => {
      const before = this.store.db.totalChanges()
      this.#set({ state: 'syncing' })
      try {
        const conn = this.#conn
        if (!conn) return
        if (!this.status.available) {
          // Sync was on but the server wasn't reachable at startup: look again.
          const server = await conn.probe()
          if (!server) throw new Error('The sync server isn’t there')
          this.status.available = true
          this.status.server = server.name
        }
        await syncOnce(this.store, conn.send)
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
    if (!this.#conn) {
      this.#set({ state: 'off' })
      return { ...this.status }
    }
    let wiped = false
    if (this.store.syncInfo().epoch === null && this.#serverHasData) wiped = this.store.syncPrepareJoin()
    this.#set({ state: 'idle' }, wiped)
    await this.run()
    return { ...this.status }
  }

}
