<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import Icon from './Icon.vue'
import KindIcon from './KindIcon.vue'
import TextView from './TextView.vue'
import type { Backlink } from '@/db/types'
import { prefs } from '@/state/prefs'

const props = defineProps<{ backlinks: Backlink[]; heading: string }>()
const emit = defineEmits<{ toggle: [id: string, done: boolean] }>()
const router = useRouter()

// What the links say they are ("buy at", "waiting on"), most used first; '' is "no relation".
const relations = computed(() => {
  const counts = new Map<string, number>()
  for (const b of props.backlinks) counts.set(b.phrase ?? '', (counts.get(b.phrase ?? '') ?? 0) + 1)
  return [...counts]
    .map(([phrase, count]) => ({ phrase, count }))
    .sort((a, b) => b.count - a.count || (a.phrase === '' ? 1 : b.phrase === '' ? -1 : a.phrase.localeCompare(b.phrase)))
})
const picked = ref<string | null>(null)
const filter = computed(() => (picked.value !== null && relations.value.some((r) => r.phrase === picked.value) ? picked.value : null))
const shown = computed(() => (filter.value === null ? props.backlinks : props.backlinks.filter((b) => (b.phrase ?? '') === filter.value)))

// Open to-dos first, then plain mentions (notes, pads, places), then what's done.
const open = computed(() => shown.value.filter((b) => b.source.task && !b.source.done))
const mentions = computed(() => shown.value.filter((b) => !b.source.task))
const done = computed(() => shown.value.filter((b) => b.source.done))
const showDone = ref(prefs.showDoneBacklinks)

const summary = computed(() => {
  const parts: string[] = []
  if (open.value.length) parts.push(`${open.value.length} open`)
  const m = mentions.value.length
  if (m) parts.push(`${m} ${m === 1 ? 'mention' : 'mentions'}`)
  if (done.value.length) parts.push(`${done.value.length} done`)
  return parts.join(', ')
})

function setShowDone(v: boolean) {
  showDone.value = v
  prefs.showDoneBacklinks = v
}

const crumbText = (b: Backlink) => b.crumbs.map((c) => c.label || 'Untitled').join(' › ')
</script>

<template>
  <section class="backlinks">
    <h2 class="section-title">
      {{ heading }}
      <span v-if="summary" class="count">{{ summary }}</span>
    </h2>
    <p v-if="!backlinks.length" class="empty-note">Nothing links here yet. Type @ in any list to link to it.</p>
    <div v-if="relations.length > 1" class="rel-chips" role="group" aria-label="Show links by kind">
      <button type="button" class="rel-chip" :aria-pressed="filter === null" @click="picked = null">
        All <span class="n">{{ backlinks.length }}</span>
      </button>
      <button
        v-for="r in relations"
        :key="r.phrase"
        type="button"
        class="rel-chip"
        :class="{ other: !r.phrase }"
        :aria-pressed="filter === r.phrase"
        @click="picked = filter === r.phrase ? null : r.phrase"
      >
        {{ r.phrase || 'other' }} <span class="n">{{ r.count }}</span>
      </button>
    </div>
    <ul v-if="open.length" class="backlink-list">
      <li v-for="b in open" :key="b.source.id" class="backlink">
        <button
          type="button"
          class="check"
          role="checkbox"
          :aria-checked="false"
          aria-label="Done"
          @click="emit('toggle', b.source.id, true)"
        >
          <span class="box" />
        </button>
        <div class="backlink-body" @click="router.push(`/n/${b.source.id}`)">
          <div v-if="b.crumbs.length || b.phrase" class="crumbline">
            <span v-if="b.phrase" class="rel">{{ b.phrase }}</span>{{ crumbText(b) }}
          </div>
          <TextView :text="b.source.text" />
        </div>
      </li>
    </ul>
    <ul v-if="mentions.length" class="backlink-list mentions">
      <li v-for="b in mentions" :key="b.source.id" class="backlink mention">
        <span class="backlink-mark" :class="`kind-${b.source.kind}`" aria-hidden="true">
          <KindIcon v-if="b.source.kind !== 'item'" :kind="b.source.kind" :size="16" />
          <span v-else class="dot" />
        </span>
        <div class="backlink-body" @click="router.push(`/n/${b.source.id}`)">
          <div v-if="b.crumbs.length || b.phrase" class="crumbline">
            <span v-if="b.phrase" class="rel">{{ b.phrase }}</span>{{ crumbText(b) }}
          </div>
          <TextView :text="b.source.text" />
        </div>
      </li>
    </ul>
    <button v-if="done.length" type="button" class="link-btn" @click="setShowDone(!showDone)">
      {{ showDone ? 'Hide' : 'Show' }} {{ done.length }} done
    </button>
    <ul v-if="showDone && done.length" class="backlink-list">
      <li v-for="b in done" :key="b.source.id" class="backlink done">
        <button
          type="button"
          class="check"
          role="checkbox"
          :aria-checked="true"
          aria-label="Done"
          @click="emit('toggle', b.source.id, false)"
        >
          <span class="box"><Icon name="check" :size="15" :stroke="3" /></span>
        </button>
        <div class="backlink-body" @click="router.push(`/n/${b.source.id}`)">
          <div v-if="b.crumbs.length || b.phrase" class="crumbline">
            <span v-if="b.phrase" class="rel">{{ b.phrase }}</span>{{ crumbText(b) }}
          </div>
          <TextView :text="b.source.text" />
        </div>
      </li>
    </ul>
  </section>
</template>
