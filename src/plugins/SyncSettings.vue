<script setup lang="ts">
// The Sync card in Settings. This is the open-source default: sync with the
// server this site has, if it has one. A build that syncs another way (see
// plugins/sync.ts) can swap this component for its own.
import { computed, onUnmounted, ref } from 'vue'
import Icon from '@/components/Icon.vue'
import { api, syncState } from '@/db/api'
import { reportError, toast } from '@/state/ui'

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
</script>

<template>
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
</template>
