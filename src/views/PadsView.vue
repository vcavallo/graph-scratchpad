<script setup lang="ts">
import { useRouter } from 'vue-router'
import Icon from '@/components/Icon.vue'
import { api } from '@/db/api'
import type { PadSummary } from '@/db/types'
import { useLoader } from '@/composables/useLoader'
import { confirmDialog, openSheet, reportError, toast } from '@/state/ui'
import { prefs } from '@/state/prefs'

const router = useRouter()
const { data: pads, loading } = useLoader(() => api.listPads())

function newPad() {
  const id = crypto.randomUUID()
  api.createPad('', id).catch(reportError)
  void router.push({ path: `/n/${id}`, query: { focus: 'title' } })
}

async function move(p: PadSummary, dir: -1 | 1) {
  const list = pads.value ?? []
  const i = list.findIndex((x) => x.id === p.id)
  if (i + dir < 0 || i + dir >= list.length) return
  // reorderPad places it after a given pad; find the one that will precede it.
  const others = list.filter((x) => x.id !== p.id)
  const after = dir === -1 ? (others[i - 2]?.id ?? null) : others[i].id
  await api.reorderPad(p.id, after).catch(reportError)
}

async function remove(p: PadSummary) {
  if (p.itemCount > 0) {
    const ok = await confirmDialog({
      title: `Delete “${p.label || 'Untitled'}”?`,
      message: `It has ${p.itemCount} ${p.itemCount === 1 ? 'item' : 'items'}. You can restore it from Trash in Settings.`,
      confirmLabel: 'Delete pad',
      danger: true,
    })
    if (!ok) return
  }
  try {
    await api.deleteSubtree(p.id)
    if (prefs.lastPad === p.id) prefs.lastPad = null
    toast(`Deleted “${p.label || 'Untitled'}”`, {
      action: { label: 'Undo', run: () => void api.restoreSubtree(p.id).catch(reportError) },
    })
  } catch (e) {
    reportError(e)
  }
}

function menu(p: PadSummary, i: number) {
  const n = pads.value?.length ?? 0
  openSheet({
    title: p.label || 'Untitled',
    actions: [
      { label: 'Rename', icon: 'edit', run: () => router.push({ path: `/n/${p.id}`, query: { focus: 'title' } }) },
      ...(i > 0 ? [{ label: 'Move up', icon: 'arrow-up', run: () => void move(p, -1) }] : []),
      ...(i < n - 1 ? [{ label: 'Move down', icon: 'arrow-down', run: () => void move(p, 1) }] : []),
      { label: 'Delete pad', icon: 'trash', danger: true, run: () => void remove(p) },
    ],
  })
}
</script>

<template>
  <div class="page">
    <header class="topbar">
      <h1 class="page-title">Pads</h1>
      <span class="spacer" />
      <button type="button" class="btn btn-primary btn-small" @click="newPad"><Icon name="plus" :size="18" /> New pad</button>
    </header>
    <div v-if="loading && !pads" class="loading" />
    <p v-else-if="pads && !pads.length" class="empty-state">No pads yet. A pad is a list; start one for a project, a trip, or the groceries.</p>
    <ul v-else class="list">
      <li v-for="(p, i) in pads" :key="p.id" class="list-item">
        <RouterLink :to="`/n/${p.id}`" class="list-main">
          <span class="list-label">{{ p.label || 'Untitled' }}</span>
          <span class="list-meta">{{ p.openCount }} open<template v-if="p.itemCount > p.openCount"> of {{ p.itemCount }}</template></span>
        </RouterLink>
        <button type="button" class="icon-btn" :aria-label="`Options for ${p.label || 'Untitled'}`" @click="menu(p, i)">
          <Icon name="more" />
        </button>
      </li>
    </ul>
  </div>
</template>
