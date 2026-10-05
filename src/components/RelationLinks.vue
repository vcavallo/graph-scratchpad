<script setup lang="ts">
// Every link of one relation, grouped by what it links to: "buy at" →
// Hardware store (3), Garden center (2).
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import Icon from './Icon.vue'
import KindIcon from './KindIcon.vue'
import TextView from './TextView.vue'
import type { RelationLink } from '@/db/types'
import { chipClass, chipLabel } from '@/lib/editorDom'

const props = defineProps<{ links: RelationLink[]; heading: string }>()
const emit = defineEmits<{ toggle: [id: string, done: boolean] }>()
const router = useRouter()

const groups = computed(() => {
  const by = new Map<string, { target: RelationLink['target']; links: RelationLink[] }>()
  for (const l of props.links) {
    if (!by.has(l.target.id)) by.set(l.target.id, { target: l.target, links: [] })
    by.get(l.target.id)!.links.push(l)
  }
  return [...by.values()].sort((a, b) => b.links.length - a.links.length || a.target.label.localeCompare(b.target.label))
})
const crumbText = (l: RelationLink) => l.crumbs.map((c) => c.label || 'Untitled').join(' › ')
</script>

<template>
  <section class="backlinks relation-links">
    <h2 class="section-title">
      {{ heading }} <span class="count">{{ links.length }}</span>
    </h2>
    <p v-if="!links.length" class="empty-note">No links are labelled with this yet.</p>
    <div v-for="g in groups" :key="g.target.id" class="rel-group">
      <RouterLink :to="`/n/${g.target.id}`" :class="chipClass(g.target)" class="rel-group-head">{{ chipLabel(g.target) }}</RouterLink>
      <ul class="backlink-list">
        <li v-for="l in g.links" :key="l.source.id" class="backlink" :class="{ done: l.source.done }">
          <button
            v-if="l.source.task"
            type="button"
            class="check"
            role="checkbox"
            :aria-checked="l.source.done"
            aria-label="Done"
            @click="emit('toggle', l.source.id, !l.source.done)"
          >
            <span class="box"><Icon v-if="l.source.done" name="check" :size="15" :stroke="3" /></span>
          </button>
          <span v-else class="backlink-mark" :class="`kind-${l.source.kind}`" aria-hidden="true">
            <KindIcon v-if="l.source.kind !== 'item'" :kind="l.source.kind" :size="16" />
            <span v-else class="dot" />
          </span>
          <div class="backlink-body" @click="router.push(`/n/${l.source.id}`)">
            <div v-if="l.crumbs.length || l.pinned" class="crumbline">
              <span v-if="l.pinned" class="pin-note">chosen for this link · </span>{{ crumbText(l) }}
            </div>
            <TextView :text="l.source.text" />
          </div>
        </li>
      </ul>
    </div>
  </section>
</template>
