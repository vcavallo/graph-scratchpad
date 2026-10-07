<script setup lang="ts">
// Read-only rendering of node text with link chips.
import { computed } from 'vue'
import { splitTokens } from '@/lib/tokens'
import { findUrls } from '@/lib/urls'
import { chipClass, chipLabel } from '@/lib/editorDom'
import { refCache } from '@/state/refs'

const props = withDefaults(defineProps<{ text: string; links?: boolean; placeholder?: string }>(), {
  links: true,
  placeholder: 'Untitled',
})
const segs = computed(() => splitTokens(props.text))

/** Plain text, with its web addresses as links. */
function parts(text: string): { text: string; href?: string }[] {
  const out: { text: string; href?: string }[] = []
  let at = 0
  for (const u of findUrls(text)) {
    if (u.start > at) out.push({ text: text.slice(at, u.start) })
    out.push({ text: u.text, href: u.href })
    at = u.end
  }
  if (at < text.length) out.push({ text: text.slice(at) })
  return out
}
</script>

<template>
  <span class="textview">
    <template v-if="segs.length === 0"><span class="placeholder">{{ placeholder }}</span></template>
    <template v-for="(s, i) in segs" :key="i">
      <template v-if="s.type === 'text'">
        <template v-for="(p, j) in parts(s.value)" :key="j">
          <a v-if="p.href && links" :href="p.href" class="url" target="_blank" rel="noopener" @click.stop>{{ p.text }}</a>
          <span v-else-if="p.href" class="url">{{ p.text }}</span>
          <template v-else>{{ p.text }}</template>
        </template>
      </template>
      <RouterLink v-else-if="links" :to="`/n/${s.id}`" :class="chipClass(refCache[s.id])" @click.stop>{{
        chipLabel(refCache[s.id])
      }}</RouterLink>
      <span v-else :class="chipClass(refCache[s.id])">{{ chipLabel(refCache[s.id]) }}</span>
    </template>
  </span>
</template>
