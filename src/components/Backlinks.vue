<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import Icon from './Icon.vue'
import TextView from './TextView.vue'
import type { Backlink } from '@/db/types'
import { prefs } from '@/state/prefs'

const props = defineProps<{ backlinks: Backlink[]; heading: string }>()
const emit = defineEmits<{ toggle: [id: string, done: boolean] }>()
const router = useRouter()

const open = computed(() => props.backlinks.filter((b) => !b.source.done))
const done = computed(() => props.backlinks.filter((b) => b.source.done))
const showDone = ref(prefs.showDoneBacklinks)

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
      <span class="count">{{ open.length }} open{{ done.length ? `, ${done.length} done` : '' }}</span>
    </h2>
    <p v-if="!backlinks.length" class="empty-note">Nothing links here yet. Type @ in any list to link to it.</p>
    <ul class="backlink-list">
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
          <div v-if="b.crumbs.length" class="crumbline">{{ crumbText(b) }}</div>
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
          <div v-if="b.crumbs.length" class="crumbline">{{ crumbText(b) }}</div>
          <TextView :text="b.source.text" />
        </div>
      </li>
    </ul>
  </section>
</template>
