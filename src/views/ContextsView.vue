<script setup lang="ts">
// Every kind of context (pin the ones you use to the bar), and the things you
// link to that don't have a kind yet, with a kind suggested from how you link
// to them.
import { useRouter } from 'vue-router'
import Icon from '@/components/Icon.vue'
import { api } from '@/db/api'
import { useLoader } from '@/composables/useLoader'
import { categories, categoryById } from '@/state/categories'
import { chooseCategory, newCategory, togglePinned } from '@/lib/contextActions'
import { reportError, toast } from '@/state/ui'
import type { ContextEntry } from '@/db/types'

const router = useRouter()
const { data: others } = useLoader(() => api.listOtherContexts())

async function addKind() {
  const id = await newCategory()
  if (id) void router.push(`/c/${id}`)
}

function accept(e: ContextEntry) {
  const c = categoryById(e.suggested)
  if (!c) return
  api
    .setCategory(e.id, c.id)
    .then(() => toast(`“${e.label}” is in ${c.name}`))
    .catch(reportError)
}

const meta = (e: ContextEntry) => (e.openBacklinks ? `${e.openBacklinks} open` : `${e.totalBacklinks} linked`)
</script>

<template>
  <div class="page contexts-page">
    <header class="topbar">
      <h1 class="page-title">Contexts</h1>
      <span class="spacer" />
      <button type="button" class="btn btn-primary btn-small" @click="addKind"><Icon name="plus" :size="18" /> New kind</button>
    </header>
    <p class="note">The things you link to, by kind. Pin a kind to give it its own tab.</p>

    <ul class="list">
      <li v-for="c in categories" :key="c.id" class="list-item">
        <RouterLink :to="`/c/${c.id}`" class="list-main">
          <span class="kind-icon" :class="`tone-${c.tone}`"><Icon :name="c.icon" :size="18" /></span>
          <span class="list-text">
            <span class="list-label">{{ c.name }}</span>
            <span class="list-context">{{ c.count }} {{ c.count === 1 ? 'context' : 'contexts' }}<template v-if="c.open">, {{ c.open }} open</template></span>
          </span>
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

    <template v-if="others?.length">
      <h2 class="section-title">Other things you link to</h2>
      <ul class="list">
        <li v-for="e in others" :key="e.id" class="list-item">
          <RouterLink :to="`/n/${e.id}`" class="list-main">
            <span class="list-text">
              <span class="list-label">{{ e.label || 'Untitled' }}</span>
              <span class="list-context">{{ meta(e) }}</span>
            </span>
          </RouterLink>
          <button v-if="categoryById(e.suggested)" type="button" class="btn btn-small suggest-btn" @click="accept(e)">
            <Icon :name="categoryById(e.suggested)!.icon" :size="16" /> {{ categoryById(e.suggested)!.name }}?
          </button>
          <button type="button" class="icon-btn" :aria-label="`Choose a kind for ${e.label}`" @click="chooseCategory(e.id, e.label, null)">
            <Icon name="more" />
          </button>
        </li>
      </ul>
    </template>
  </div>
</template>
