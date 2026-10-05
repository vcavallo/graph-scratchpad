<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '@/components/Icon.vue'
import { api, dbState, syncState } from '@/db/api'
import type { DbInfo } from '@/db/types'
import { useLoader } from '@/composables/useLoader'
import { confirmDialog, reportError, toast } from '@/state/ui'
import { prefs } from '@/state/prefs'
import { lastBackup, recordBackup, requestPersistence, storageStatus } from '@/lib/storage'
import { installState, promptInstall } from '@/lib/install'
import { MAX_PINNED, categories } from '@/state/categories'
import { newCategory, togglePinned } from '@/lib/contextActions'

const router = useRouter()
const { data: info } = useLoader<DbInfo>(() => api.dbInfo())
const { data: trash } = useLoader(() => api.listDeleted())
const fileInput = ref<HTMLInputElement>()
const canShare = ref(false)
const busy = ref(false)

// Re-render "synced 2 min ago" now and then.
const tick = ref(Date.now())
const ticker = setInterval(() => (tick.value = Date.now()), 30_000)
onUnmounted(() => clearInterval(ticker))

const syncLine = computed(() => {
  const p = syncState.pending
  switch (syncState.state) {
    case 'syncing':
      return 'Syncing…'
    case 'idle':
      return p ? `${p} ${p === 1 ? 'change' : 'changes'} waiting to sync` : 'Up to date'
    case 'offline':
      return 'Can’t reach the server. Changes stay on this device and sync when it’s back.'
    case 'error':
      return `Sync failed: ${syncState.error}. Trying again shortly.`
    default:
      return 'Off. Lists on this device stay here. Turning sync on merges them with the server’s.'
  }
})

const labelsBy = computed(() => {
  const m = syncState.labels
  if (!m) return 'Guessed on this device from the words around each link'
  const name = /haiku/i.test(m) ? 'Claude Haiku' : /sonnet/i.test(m) ? 'Claude Sonnet' : m
  return `Read by ${name} on ${syncState.server || 'the server'}; this device’s own guess until then`
})

const lastSynced = computed(() => {
  const at = syncState.lastSync
  if (!at) return 'Not yet'
  const mins = Math.round((tick.value - at) / 60_000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins} min ago`
  return new Date(at).toLocaleString()
})

async function syncNow() {
  const s = await api.syncNow().catch(reportError)
  if (s && s.state === 'idle') toast('Up to date')
}

async function toggleSync() {
  const on = !syncState.enabled
  const s = await api.syncEnable(on).catch(reportError)
  if (s) toast(on ? `Sync is on with ${s.server || 'the server'}` : 'Sync is off. Lists on this device stay here.')
}

async function install() {
  const ok = await promptInstall()
  if (ok) toast('Installed. Open it from the home screen icon.')
}

const buildTime = new Date(__BUILD_TIME__).toLocaleString()
const version = __APP_VERSION__

onMounted(async () => {
  void storageStatus.refresh()
  try {
    const probe = new File(['{}'], 'probe.json', { type: 'application/json' })
    canShare.value = !!navigator.canShare?.({ files: [probe] })
  } catch {
    canShare.value = false
  }
})

function fmtBytes(n: number | undefined): string {
  if (n === undefined) return '?'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`
}

async function backupFile(): Promise<File> {
  const data = await api.exportAll()
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
  return new File([JSON.stringify(data, null, 1)], `graph-paper-${stamp}.json`, { type: 'application/json' })
}

async function download() {
  busy.value = true
  try {
    const file = await backupFile()
    const url = URL.createObjectURL(file)
    const a = document.createElement('a')
    a.href = url
    a.download = file.name
    document.body.append(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    recordBackup()
    toast('Backup downloaded')
  } catch (e) {
    reportError(e)
  } finally {
    busy.value = false
  }
}

async function share() {
  busy.value = true
  try {
    const file = await backupFile()
    await navigator.share({ files: [file], title: 'Graph Paper backup' })
    recordBackup()
  } catch (e) {
    if ((e as Error).name !== 'AbortError') reportError(e)
  } finally {
    busy.value = false
  }
}

async function onImportFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  let data: unknown
  try {
    data = JSON.parse(await file.text())
  } catch {
    toast('That file isn’t valid JSON. Choose a backup exported from Graph Paper.', { tone: 'error', ms: 6000 })
    return
  }
  const count = Array.isArray((data as { nodes?: unknown[] })?.nodes) ? (data as { nodes: unknown[] }).nodes.length : 0
  const ok = await confirmDialog({
    title: 'Replace everything with this backup?',
    message: syncState.enabled
      ? `The backup has ${count} ${count === 1 ? 'entry' : 'entries'}. Sync is on, so it’s merged with your synced lists: its version of each entry wins, and entries it doesn’t have are kept.`
      : `The backup has ${count} ${count === 1 ? 'entry' : 'entries'}. Everything currently on this device will be replaced. Export first if you want to keep it.`,
    confirmLabel: 'Replace',
    danger: true,
  })
  if (!ok) return
  try {
    const r = await api.importAll(data)
    prefs.lastPad = null
    toast(`Imported ${r.nodes} entries and ${r.edges} connections`)
    void router.push('/')
  } catch (err) {
    reportError(err)
  }
}

async function askPersist() {
  const granted = await requestPersistence()
  toast(
    granted
      ? 'Storage is now persistent'
      : 'The browser declined. Installing the app to your home screen usually makes storage persistent.',
    { ms: granted ? 3000 : 7000 },
  )
}
</script>

<template>
  <div class="page settings">
    <header class="topbar">
      <h1 class="page-title">Settings</h1>
    </header>

    <section class="card">
      <h2 class="section-title">Storage</h2>
      <p v-if="dbState.storage === 'memory'" class="warn">
        Changes are not being saved: this browser couldn’t open on-device storage ({{ dbState.reason || 'OPFS unavailable' }}).
        Use Chrome over HTTPS.
      </p>
      <dl class="facts">
        <div>
          <dt>Kept on this device</dt>
          <dd>
            <template v-if="storageStatus.persisted === null">Checking…</template>
            <template v-else-if="storageStatus.persisted">Yes, the browser won’t clear it on its own</template>
            <template v-else>Not guaranteed; the browser may clear it under storage pressure</template>
          </dd>
        </div>
        <div>
          <dt>Space used</dt>
          <dd>{{ fmtBytes(storageStatus.usage) }} of {{ fmtBytes(storageStatus.quota) }} available</dd>
        </div>
      </dl>
      <button v-if="storageStatus.persisted === false" type="button" class="btn" @click="askPersist">
        <Icon name="shield" :size="18" /> Ask to keep data
      </button>
    </section>

    <section class="card nav-card">
      <h2 class="section-title">Tabs</h2>
      <p class="note">
        Give up to {{ MAX_PINNED }} kinds of context a tab in the bar. The rest are under Contexts, with everything else you
        link to.
      </p>
      <ul class="list">
        <li v-for="c in categories" :key="c.id" class="list-item">
          <RouterLink :to="`/c/${c.id}`" class="list-main">
            <span class="kind-icon" :class="`tone-${c.tone}`"><Icon :name="c.icon" :size="18" /></span>
            <span class="list-label">{{ c.name }}</span>
          </RouterLink>
          <button
            type="button"
            class="pin-toggle"
            :aria-pressed="c.pinned"
            :aria-label="c.pinned ? `Take ${c.name} out of the bar` : `Give ${c.name} a tab`"
            @click="togglePinned(c.id)"
          >
            <Icon name="pin" :size="18" /><span>{{ c.pinned ? 'In bar' : 'Pin' }}</span>
          </button>
        </li>
      </ul>
      <button type="button" class="btn" @click="newCategory"><Icon name="plus" :size="18" /> New kind of context</button>
    </section>

    <section class="card app-card">
      <h2 class="section-title">App</h2>
      <p v-if="installState.standalone" class="note">Running as an installed app, in its own window.</p>
      <template v-else>
        <p class="note">
          Running in a browser tab.
          <template v-if="installState.installed">It’s installed now: open it from the home screen icon.</template>
          <template v-else-if="installState.canInstall">Install it to open it from the home screen in its own window, without the address bar.</template>
          <template v-else>
            To open it in its own window: if the home screen icon opens a tab, it’s a bookmark shortcut. Remove it, then
            use <strong>Install app</strong> in the browser’s menu (not a shortcut).
          </template>
        </p>
        <div v-if="installState.canInstall" class="btn-row">
          <button type="button" class="btn btn-primary" @click="install"><Icon name="download" :size="18" /> Install app</button>
        </div>
      </template>
    </section>

    <section class="card sync-card">
      <h2 class="section-title">Sync</h2>
      <p v-if="!syncState.checked" class="note">Looking for a sync server…</p>
      <p v-else-if="!syncState.available && !syncState.enabled" class="note">
        This site has no sync server, so everything stays on this device.
      </p>
      <template v-else>
        <p class="note sync-line" :class="syncState.state">{{ syncLine }}</p>
        <dl class="facts">
          <div><dt>Server</dt><dd>{{ syncState.server || 'Not reachable yet' }}</dd></div>
          <div v-if="syncState.enabled"><dt>Last synced</dt><dd>{{ lastSynced }}</dd></div>
          <div v-if="syncState.enabled">
            <dt>Link labels</dt>
            <dd>{{ labelsBy }}</dd>
          </div>
        </dl>
        <div class="btn-row">
          <button
            v-if="syncState.enabled"
            type="button"
            class="btn btn-primary"
            :disabled="syncState.state === 'syncing'"
            @click="syncNow"
          >
            <Icon name="sync" :size="18" /> Sync now
          </button>
          <button type="button" class="btn" @click="toggleSync">
            {{ syncState.enabled ? 'Turn off sync' : 'Turn on sync' }}
          </button>
        </div>
      </template>
    </section>

    <section class="card">
      <h2 class="section-title">Backup</h2>
      <p class="note">
        <template v-if="syncState.enabled">
          Your lists are also kept on {{ syncState.server || 'the sync server' }}, which saves a copy every day. An export
          is still a good extra backup: one JSON file you can import anywhere.
        </template>
        <template v-else>
          Everything lives only on this device. Export a backup now and then; it’s one JSON file you can import into a
          fresh install.
        </template>
        <template v-if="lastBackup.at"><br />Last backup: {{ new Date(lastBackup.at).toLocaleString() }}.</template>
      </p>
      <div class="btn-row">
        <button type="button" class="btn btn-primary" :disabled="busy" @click="download"><Icon name="download" :size="18" /> Export</button>
        <button v-if="canShare" type="button" class="btn" :disabled="busy" @click="share"><Icon name="share" :size="18" /> Share</button>
        <button type="button" class="btn" @click="fileInput?.click()"><Icon name="upload" :size="18" /> Import</button>
      </div>
      <input ref="fileInput" type="file" accept="application/json,.json" hidden @change="onImportFile" />
    </section>

    <section class="card">
      <h2 class="section-title">Relations</h2>
      <RouterLink to="/relations" class="list-main row-link">
        <Icon name="linked" :size="20" />
        <span class="list-label">What your links mean</span>
        <Icon name="chevron-right" :size="18" />
      </RouterLink>
    </section>

    <section class="card">
      <h2 class="section-title">Trash</h2>
      <RouterLink to="/trash" class="list-main row-link">
        <Icon name="trashcan" :size="20" />
        <span class="list-label">{{ trash?.length ? `${trash.length} deleted ${trash.length === 1 ? 'entry' : 'entries'}` : 'Empty' }}</span>
        <Icon name="chevron-right" :size="18" />
      </RouterLink>
    </section>

    <section class="card">
      <h2 class="section-title">About</h2>
      <dl class="facts">
        <div><dt>Version</dt><dd>{{ version }}, built {{ buildTime }}</dd></div>
        <div v-if="info"><dt>Entries</dt><dd>{{ info.nodeCount }} live, {{ info.edgeCount }} connections</dd></div>
        <div v-if="info"><dt>Database</dt><dd>SQLite {{ info.sqliteVersion }}, schema {{ info.schemaVersion }}, {{ info.storage }}</dd></div>
      </dl>
    </section>
  </div>
</template>
