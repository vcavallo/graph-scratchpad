<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '@/components/Icon.vue'
import { api, dbState } from '@/db/api'
import type { DbInfo } from '@/db/types'
import { useLoader } from '@/composables/useLoader'
import { confirmDialog, reportError, toast } from '@/state/ui'
import { prefs } from '@/state/prefs'
import { lastBackup, recordBackup, requestPersistence, storageStatus } from '@/lib/storage'

const router = useRouter()
const { data: info } = useLoader<DbInfo>(() => api.dbInfo())
const { data: trash } = useLoader(() => api.listDeleted())
const fileInput = ref<HTMLInputElement>()
const canShare = ref(false)
const busy = ref(false)

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
  return new File([JSON.stringify(data, null, 1)], `scratchpad-${stamp}.json`, { type: 'application/json' })
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
    await navigator.share({ files: [file], title: 'Scratchpad backup' })
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
    toast('That file isn’t valid JSON. Choose a backup exported from Scratchpad.', { tone: 'error', ms: 6000 })
    return
  }
  const count = Array.isArray((data as { nodes?: unknown[] })?.nodes) ? (data as { nodes: unknown[] }).nodes.length : 0
  const ok = await confirmDialog({
    title: 'Replace everything with this backup?',
    message: `The backup has ${count} ${count === 1 ? 'entry' : 'entries'}. Everything currently on this device will be replaced. Export first if you want to keep it.`,
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

    <section class="card">
      <h2 class="section-title">Backup</h2>
      <p class="note">
        Everything lives only on this device. Export a backup now and then; it’s one JSON file you can import into a fresh install.
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
