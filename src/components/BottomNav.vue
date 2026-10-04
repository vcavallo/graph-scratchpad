<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import Icon from './Icon.vue'

const route = useRoute()
const tabs = [
  { to: '/pads', label: 'Pads', icon: 'list', match: ['/pads', '/n/'] },
  { to: '/places', label: 'Places', icon: 'pin', match: ['/places'] },
  { to: '/people', label: 'People', icon: 'person', match: ['/people'] },
  { to: '/search', label: 'Search', icon: 'search', match: ['/search'] },
  { to: '/settings', label: 'Settings', icon: 'settings', match: ['/settings', '/trash'] },
]
const current = computed(() => tabs.find((t) => t.match.some((m) => route.path.startsWith(m)))?.to)
</script>

<template>
  <nav class="bottom-nav" aria-label="Sections">
    <RouterLink
      v-for="t in tabs"
      :key="t.to"
      :to="t.to"
      class="nav-tab"
      :class="{ on: current === t.to }"
      :aria-current="current === t.to ? 'page' : undefined"
    >
      <Icon :name="t.icon" :size="22" />
      <span>{{ t.label }}</span>
    </RouterLink>
  </nav>
</template>
