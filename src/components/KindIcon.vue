<script setup lang="ts">
import Icon from './Icon.vue'
import type { Kind } from '@/db/types'

withDefaults(defineProps<{ kind: Kind; size?: number }>(), { size: 18 })
const NAMES: Record<Kind, string> = { pad: 'pad', item: 'dot', place: 'pin', person: 'person', relation: 'linked' }
</script>

<template>
  <span class="kind-icon" :class="`kind-${kind}`"><Icon :name="NAMES[kind]" :size="size" /></span>
</template>
