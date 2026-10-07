<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
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
import { setVimEnabled, vim } from '@/state/vim'
import SyncSettings from '@/plugins/SyncSettings.vue'
import { setTheme, theme, type ThemeChoice } from '@/lib/theme'
import { APP_CONTACT, APP_NAME, APP_SITE, ISSUES_URL } from '@/lib/appName'

const THEMES: { value: ThemeChoice; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

const router = useRouter()
const route = useRoute()

// Three tabs: using the app, where the data lives (sync, backups, storage), and about it.
// The tab is in the address (?tab=sync), so a link can open the right one.
const TABS = [
  { id: 'general', label: 'General' },
  { id: 'sync', label: 'Sync & data' },
  { id: 'about', label: 'About' },
] as const
type TabId = (typeof TABS)[number]['id']
const tab = computed<TabId>(() => {
  const t = route.query.tab
  return t === 'sync' || t === 'about' ? t : 'general'
})
function selectTab(id: TabId) {
  void router.replace({ query: id === 'general' ? {} : { tab: id } })
}
const { data: info } = useLoader<DbInfo>(() => api.dbInfo())
const { data: trash } = useLoader(() => api.listDeleted())
const fileInput = ref<HTMLInputElement>()
const canShare = ref(false)
const busy = ref(false)

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
    await navigator.share({ files: [file], title: `${APP_NAME} backup` })
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
    toast(`That file isn’t valid JSON. Choose a backup exported from ${APP_NAME}.`, { tone: 'error', ms: 6000 })
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

    <div class="segmented settings-tabs" role="tablist" aria-label="Settings">
      <button
        v-for="t in TABS"
        :key="t.id"
        type="button"
        role="tab"
        :aria-selected="tab === t.id"
        :class="{ on: tab === t.id }"
        @click="selectTab(t.id)"
      >
        {{ t.label }}
      </button>
    </div>

    <template v-if="tab === 'general'">
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

      <section class="card nav-card">
        <h2 class="section-title">Bottom bar</h2>
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
        <button type="button" class="btn" @click="newCategory"><Icon name="plus" :size="18" /> New kind</button>
      </section>

      <section class="card appearance-card">
        <h2 class="section-title">Appearance</h2>
        <div class="segmented" role="radiogroup" aria-label="Theme">
          <button
            v-for="t in THEMES"
            :key="t.value"
            type="button"
            role="radio"
            :aria-checked="theme.choice === t.value"
            :class="{ on: theme.choice === t.value }"
            @click="setTheme(t.value)"
          >
            {{ t.label }}
          </button>
        </div>
        <p class="note">System follows your device’s light or dark setting. The choice is kept on this device.</p>
      </section>

      <section class="card vim-card">
        <h2 class="section-title">Keyboard</h2>
        <p class="note">
          <template v-if="vim.enabled">
            Vim keys are on, on this device. <kbd>Esc</kbd> for normal mode: <kbd>h</kbd> <kbd>j</kbd> <kbd>k</kbd> <kbd>l</kbd> move,
            <kbd>w</kbd> <kbd>b</kbd> <kbd>e</kbd> jump words, <kbd>0</kbd> <kbd>$</kbd> <kbd>gg</kbd> <kbd>G</kbd> go to the ends, <kbd>x</kbd> <kbd>dd</kbd> <kbd>dw</kbd> <kbd>D</kbd> delete,
            <kbd>cw</kbd> <kbd>cc</kbd> <kbd>C</kbd> <kbd>r</kbd> change, <kbd>o</kbd> <kbd>O</kbd> open a line, <kbd>&gt;&gt;</kbd> <kbd>&lt;&lt;</kbd> indent, <kbd>za</kbd> folds,
            <kbd>yy</kbd> <kbd>p</kbd> copy and put, <kbd>u</kbd> undoes, <kbd>gx</kbd> opens a link,
            <kbd>Ctrl-O</kbd> <kbd>Ctrl-I</kbd> go back and forward.
            <kbd>i</kbd> <kbd>a</kbd> <kbd>I</kbd> <kbd>A</kbd> to type again. The mode shows in the bar at the bottom.
          </template>
          <template v-else>For a computer keyboard: edit with Vim’s normal and insert modes. Only on this device.</template>
        </p>
        <div class="btn-row">
          <button type="button" class="btn" @click="setVimEnabled(!vim.enabled)">
            {{ vim.enabled ? 'Turn off Vim keys' : 'Turn on Vim keys' }}
          </button>
        </div>
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
    </template>

    <template v-else-if="tab === 'sync'">
      <SyncSettings />

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
    </template>

    <template v-else>
      <section class="card">
        <h2 class="section-title">About</h2>
        <p v-if="APP_SITE" class="about-site">
          <a :href="APP_SITE" target="_blank" rel="noopener">Learn more about {{ APP_NAME }}</a>
        </p>
        <dl class="facts">
          <div><dt>Version</dt><dd>{{ version }}, built {{ buildTime }}</dd></div>
          <div v-if="info"><dt>Entries</dt><dd>{{ info.nodeCount }} live, {{ info.edgeCount }} connections</dd></div>
          <div v-if="info"><dt>Database</dt><dd>SQLite {{ info.sqliteVersion }}, schema {{ info.schemaVersion }}, {{ info.storage }}</dd></div>
          <div>
            <dt>Bugs and ideas</dt>
            <dd>
              Report a bug or ask for a feature in the <a :href="ISSUES_URL" target="_blank" rel="noopener">issues on GitHub</a
              ><template v-if="APP_CONTACT">, or email <a :href="`mailto:${APP_CONTACT}`">{{ APP_CONTACT }}</a></template>.
            </dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd><a href="https://github.com/vcavallo/graph-scratchpad" target="_blank" rel="noopener">github.com/vcavallo/graph-scratchpad</a>, public domain</dd>
          </div>
        </dl>
      </section>
    </template>
  </div>
</template>
