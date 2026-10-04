<script setup lang="ts">
// Read-only rendering of node text with link chips.
import { computed } from 'vue'
import { splitTokens } from '@/lib/tokens'
import { chipClass, chipLabel } from '@/lib/editorDom'
import { refCache } from '@/state/refs'

const props = withDefaults(defineProps<{ text: string; links?: boolean; placeholder?: string }>(), {
  links: true,
  placeholder: 'Untitled',
})
const segs = computed(() => splitTokens(props.text))
</script>

<template>
  <span class="textview">
    <template v-if="segs.length === 0"><span class="placeholder">{{ placeholder }}</span></template>
    <template v-for="(s, i) in segs" :key="i">
      <template v-if="s.type === 'text'">{{ s.value }}</template>
      <RouterLink v-else-if="links" :to="`/n/${s.id}`" :class="chipClass(refCache[s.id])" @click.stop>{{
        chipLabel(refCache[s.id])
      }}</RouterLink>
      <span v-else :class="chipClass(refCache[s.id])">{{ chipLabel(refCache[s.id]) }}</span>
    </template>
  </span>
</template>
