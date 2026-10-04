<script setup lang="ts">
// Index screens for places and people.
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '@/components/Icon.vue'
import KindIcon from '@/components/KindIcon.vue'
import { api } from '@/db/api'
import { useLoader } from '@/composables/useLoader'
import type { IndexEntry } from '@/db/types'
import { reportError } from '@/state/ui'

const props = defineProps<{ kind: 'place' | 'person' }>()
const router = useRouter()
const { data: entries, loading } = useLoader(() => api.listByKind(props.kind))

const title = computed(() => (props.kind === 'place' ? 'Places' : 'People'))

function meta(e: IndexEntry): string {
  if (e.openBacklinks) return `${e.openBacklinks} open`
  return e.totalBacklinks ? `${e.totalBacklinks} linked` : 'Nothing linked'
}
const name = ref('')

function add() {
  const text = name.value.trim()
  if (!text) return
  const id = crypto.randomUUID()
  api.createNode(props.kind, text, id).catch(reportError)
  name.value = ''
  void router.push(`/n/${id}`)
}
</script>

<template>
  <div class="page">
    <header class="topbar">
      <h1 class="page-title">{{ title }}</h1>
    </header>
    <form class="add-form" @submit.prevent="add">
      <input
        v-model="name"
        class="text-input"
        type="text"
        enterkeyhint="done"
        :placeholder="kind === 'place' ? 'Add a place, like Hardware store' : 'Add a person'"
        :aria-label="kind === 'place' ? 'New place name' : 'New person name'"
      />
      <button type="submit" class="btn btn-primary" :disabled="!name.trim()"><Icon name="plus" :size="18" /> Add</button>
    </form>
    <div v-if="loading && !entries" class="loading" />
    <p v-else-if="entries && !entries.length" class="empty-state">
      <template v-if="kind === 'place'">
        Places collect what you need to do there. Add one here, or type @ in any list and choose “New place”.
      </template>
      <template v-else>People collect what you need to bring up with them. Add someone here, or type @ in any list.</template>
    </p>
    <ul v-else class="list">
      <li v-for="e in entries" :key="e.id" class="list-item">
        <RouterLink :to="`/n/${e.id}`" class="list-main">
          <KindIcon :kind="e.kind" />
          <span class="list-label">{{ e.label || 'Untitled' }}</span>
          <span class="list-meta" :class="{ hot: e.openBacklinks > 0 }">{{ meta(e) }}</span>
        </RouterLink>
      </li>
    </ul>
  </div>
</template>
