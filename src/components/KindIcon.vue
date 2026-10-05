<script setup lang="ts">
// The icon for a node: its kind of context's icon and colour if it's a
// context, otherwise by node kind (pad, relation…).
import { computed } from 'vue'
import Icon from './Icon.vue'
import type { Kind } from '@/db/types'
import { categoryById } from '@/state/categories'

const props = withDefaults(defineProps<{ kind: Kind; category?: string | null; size?: number }>(), {
  size: 18,
  category: null,
})
const NAMES: Record<Kind, string> = { pad: 'pad', item: 'dot', place: 'pin', person: 'person', relation: 'linked', category: 'tag' }
const cat = computed(() => categoryById(props.category))
</script>

<template>
  <span v-if="cat" class="kind-icon" :class="`tone-${cat.tone}`"><Icon :name="cat.icon" :size="size" /></span>
  <span v-else class="kind-icon" :class="`kind-${kind}`"><Icon :name="NAMES[kind]" :size="size" /></span>
</template>
