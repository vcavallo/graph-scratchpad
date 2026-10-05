<script setup lang="ts">
// One kind of context: everything of that kind, with its open to-dos, and a
// box to add another. Places, People, Rooms…
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '@/components/Icon.vue'
import { api } from '@/db/api'
import { useLoader } from '@/composables/useLoader'
import { categoryById } from '@/state/categories'
import { openCategoryMenu } from '@/lib/contextActions'
import { reportError } from '@/state/ui'
import type { ContextEntry } from '@/db/types'

const props = defineProps<{ id: string }>()
const router = useRouter()
const { data: entries, loading } = useLoader(() => api.listContexts(props.id))
const cat = computed(() => categoryById(props.id))
const name = ref('')

function add() {
  const text = name.value.trim()
  if (!text) return
  const id = crypto.randomUUID()
  api.createContext(text, props.id, id).catch(reportError)
  name.value = ''
  void router.push(`/n/${id}`)
}

function meta(e: ContextEntry): string {
  if (e.openBacklinks) return `${e.openBacklinks} open`
  return e.totalBacklinks ? `${e.totalBacklinks} linked` : 'Nothing linked'
}
</script>

<template>
  <div class="page category-page" :class="cat ? `tone-${cat.tone}` : ''">
    <header class="topbar">
      <h1 class="page-title">
        <Icon v-if="cat" :name="cat.icon" :size="24" class="title-icon" />{{ cat?.name ?? '…' }}
      </h1>
      <span class="spacer" />
      <button v-if="cat" type="button" class="icon-btn" :aria-label="`Options for ${cat.name}`" @click="openCategoryMenu(id)">
        <Icon name="more" />
      </button>
    </header>
    <form class="add-form" @submit.prevent="add">
      <input
        v-model="name"
        class="add-input"
        type="text"
        enterkeyhint="done"
        autocomplete="off"
        :placeholder="cat ? `Add to ${cat.name}` : 'Add'"
        :aria-label="cat ? `New in ${cat.name}` : 'New'"
      />
      <button type="submit" class="btn btn-primary" :disabled="!name.trim()"><Icon name="plus" :size="18" /> Add</button>
    </form>
    <div v-if="loading && !entries" class="loading" />
    <p v-else-if="entries && !entries.length" class="empty-state">
      Nothing here yet. Add one above, or open any line and choose what kind of context it is from its ⋯ menu.
    </p>
    <ul v-else class="list">
      <li v-for="e in entries" :key="e.id" class="list-item">
        <RouterLink :to="`/n/${e.id}`" class="list-main">
          <span class="kind-icon" :class="cat ? `tone-${cat.tone}` : ''"><Icon :name="cat?.icon ?? 'tag'" :size="18" /></span>
          <span class="list-label">{{ e.label || 'Untitled' }}</span>
          <span class="list-meta" :class="{ hot: e.openBacklinks > 0 }">{{ meta(e) }}</span>
        </RouterLink>
      </li>
    </ul>
  </div>
</template>
