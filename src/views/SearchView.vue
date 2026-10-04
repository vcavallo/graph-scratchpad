<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import KindIcon from '@/components/KindIcon.vue'
import { api } from '@/db/api'
import type { SearchResult } from '@/db/types'
import { reportError } from '@/state/ui'
import { resultContext } from '@/lib/kinds'

const q = ref('')
const results = ref<SearchResult[]>([])
const input = ref<HTMLInputElement>()
let seq = 0

async function run() {
  const my = ++seq
  try {
    const r = await api.search(q.value, { limit: 50 })
    if (my === seq) results.value = r
  } catch (e) {
    reportError(e)
  }
}

watch(q, run)
onMounted(() => {
  void run()
  input.value?.focus()
})
</script>

<template>
  <div class="page">
    <header class="topbar">
      <h1 class="page-title">Search</h1>
    </header>
    <input
      ref="input"
      v-model="q"
      class="text-input search-input"
      type="search"
      enterkeyhint="search"
      placeholder="Search everything"
      aria-label="Search"
    />
    <p v-if="!q.trim() && results.length" class="hint">Recently edited</p>
    <ul class="list">
      <li v-for="r in results" :key="r.id" class="list-item">
        <RouterLink :to="`/n/${r.id}`" class="list-main" :class="{ done: r.done }">
          <KindIcon :kind="r.kind" />
          <span class="list-text">
            <span class="list-label">{{ r.label || 'Untitled' }}</span>
            <span v-if="resultContext(r)" class="list-context">{{ resultContext(r) }}</span>
          </span>
        </RouterLink>
      </li>
    </ul>
    <p v-if="q.trim() && !results.length" class="empty-state">Nothing matches “{{ q.trim() }}”.</p>
  </div>
</template>
