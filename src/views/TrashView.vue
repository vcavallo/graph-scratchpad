<script setup lang="ts">
import Icon from '@/components/Icon.vue'
import KindIcon from '@/components/KindIcon.vue'
import { api } from '@/db/api'
import { useLoader } from '@/composables/useLoader'
import { confirmDialog, reportError, toast } from '@/state/ui'

const { data: entries, loading } = useLoader(() => api.listDeleted())

const when = (t: number) =>
  new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

async function restore(id: string) {
  try {
    await api.restoreSubtree(id)
    toast('Restored')
  } catch (e) {
    reportError(e)
  }
}

async function empty() {
  const ok = await confirmDialog({
    title: 'Empty trash?',
    message: 'Everything in the trash is removed for good. Export a backup first if you might need it.',
    confirmLabel: 'Empty trash',
    danger: true,
  })
  if (!ok) return
  try {
    await api.purgeDeleted()
    toast('Trash emptied')
  } catch (e) {
    reportError(e)
  }
}
</script>

<template>
  <div class="page">
    <header class="topbar">
      <RouterLink class="back" to="/settings"><Icon name="chevron-left" /><span class="back-label">Settings</span></RouterLink>
      <span class="spacer" />
      <button v-if="entries?.length" type="button" class="btn btn-small btn-danger" @click="empty">Empty trash</button>
    </header>
    <h1 class="page-title standalone">Trash</h1>
    <div v-if="loading && !entries" class="loading" />
    <p v-else-if="entries && !entries.length" class="empty-state">Trash is empty. Deleted items wait here until you empty it.</p>
    <ul v-else class="list">
      <li v-for="e in entries" :key="e.id" class="list-item">
        <div class="list-main static">
          <KindIcon :kind="e.kind" />
          <span class="list-text">
            <span class="list-label">{{ e.label || 'Untitled' }}</span>
            <span class="list-context">
              Deleted {{ when(e.deleted_at) }}<template v-if="e.crumbs.length">
                from {{ e.crumbs.map((c) => c.label || 'Untitled').join(' › ') }}</template
              ><template v-if="e.count > 1">, with {{ e.count - 1 }} more</template>
            </span>
          </span>
        </div>
        <button type="button" class="btn btn-small" @click="restore(e.id)"><Icon name="undo" :size="16" /> Restore</button>
      </li>
    </ul>
  </div>
</template>
