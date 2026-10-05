<script setup lang="ts">
// Pads, the kinds of context you pinned (up to three), Contexts for the rest,
// Search and Settings.
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import Icon from './Icon.vue'
import { pinnedCategories } from '@/state/categories'

const route = useRoute()
const tabs = computed(() => [
  { to: '/pads', label: 'Pads', icon: 'list', match: (p: string) => p.startsWith('/pads') || p.startsWith('/n/') },
  ...pinnedCategories.value.map((c) => ({ to: `/c/${c.id}`, label: c.name, icon: c.icon, match: (p: string) => p === `/c/${c.id}` })),
  {
    to: '/contexts',
    label: 'Contexts',
    icon: 'grid',
    match: (p: string) => p.startsWith('/contexts') || (p.startsWith('/c/') && !pinnedCategories.value.some((c) => p === `/c/${c.id}`)),
  },
  { to: '/search', label: 'Search', icon: 'search', match: (p: string) => p.startsWith('/search') },
  {
    to: '/settings',
    label: 'Settings',
    icon: 'settings',
    match: (p: string) => ['/settings', '/trash', '/relations'].some((s) => p.startsWith(s)),
  },
])
const current = computed(() => tabs.value.find((t) => t.match(route.path))?.to)
</script>

<template>
  <nav class="bottom-nav" :class="{ crowded: tabs.length > 5 }" aria-label="Sections">
    <RouterLink
      v-for="t in tabs"
      :key="t.to"
      :to="t.to"
      class="nav-tab"
      :class="{ on: current === t.to }"
      :aria-current="current === t.to ? 'page' : undefined"
    >
      <Icon :name="t.icon" :size="22" />
      <span class="nav-label">{{ t.label }}</span>
    </RouterLink>
  </nav>
</template>
