<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import Icon from './Icon.vue'
import KindIcon from './KindIcon.vue'
import { api } from '@/db/api'
import type { Kind, SearchResult } from '@/db/types'
import { closePicker, pickerState, reportError, type PickResult } from '@/state/ui'
import { resultContext } from '@/lib/kinds'

const q = ref('')
const results = ref<SearchResult[]>([])
const highlight = ref(0)
const input = ref<HTMLInputElement>()
let seq = 0

const req = pickerState
const trimmed = computed(() => q.value.trim())
const creates = computed(() => {
  if (!req.value?.allowCreate || !trimmed.value) return []
  const exact = results.value.some((r) => r.label.toLowerCase() === trimmed.value.toLowerCase())
  if (exact && results.value.length) return []
  return [
    { kind: 'place' as Kind, label: `New place “${trimmed.value}”` },
    { kind: 'person' as Kind, label: `New person “${trimmed.value}”` },
    { kind: 'item' as Kind, label: `New item “${trimmed.value}” in Inbox` },
  ]
})

watch(req, (r) => {
  if (!r) return
  q.value = ''
  results.value = []
  highlight.value = 0
  void search()
  void nextTick(() => input.value?.focus())
})

watch(q, () => void search())

async function search() {
  const r = req.value
  if (!r) return
  const my = ++seq
  const query = q.value
  try {
    const res = await api.search(query, {
      limit: 30,
      excludeIds: r.excludeIds,
      kinds: !query.trim() && r.emptyKinds ? r.emptyKinds : undefined,
    })
    if (my !== seq) return
    results.value = res
    highlight.value = 0
  } catch (e) {
    reportError(e)
  }
}

function finish(p: PickResult) {
  const r = req.value
  closePicker()
  r?.onPick(p)
}

function pick(res: SearchResult) {
  finish({ id: res.id, kind: res.kind, label: res.label })
}

function create(kind: Kind) {
  const text = trimmed.value
  const id = crypto.randomUUID()
  const p = kind === 'item' ? api.createInInbox({ text, id }) : api.createNode(kind, text, id)
  p.catch(reportError)
  finish({ id, kind, label: text })
}

function cancel() {
  const r = req.value
  closePicker()
  r?.onCancel?.()
}

function onKey(e: KeyboardEvent) {
  const total = results.value.length + creates.value.length
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    highlight.value = Math.min(total - 1, highlight.value + 1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    highlight.value = Math.max(0, highlight.value - 1)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const i = highlight.value
    if (i < results.value.length) pick(results.value[i])
    else if (creates.value[i - results.value.length]) create(creates.value[i - results.value.length].kind)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    cancel()
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="req" class="picker" role="dialog" :aria-label="req.title">
      <div class="picker-head">
        <span class="picker-title">{{ req.title }}</span>
        <button type="button" class="icon-btn" aria-label="Cancel" @mousedown.prevent @click="cancel">
          <Icon name="x" />
        </button>
      </div>
      <input
        ref="input"
        v-model="q"
        class="picker-input"
        type="search"
        enterkeyhint="go"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        :placeholder="req.placeholder ?? 'Search'"
        @keydown="onKey"
      />
      <ul class="picker-results" role="listbox">
        <li v-for="(r, i) in results" :key="r.id">
          <button
            type="button"
            class="picker-item"
            :class="{ hl: i === highlight, done: r.done }"
            role="option"
            :aria-selected="i === highlight"
            @mousedown.prevent
            @click="pick(r)"
          >
            <KindIcon :kind="r.kind" />
            <span class="picker-text">
              <span class="picker-label">{{ r.label || 'Untitled' }}</span>
              <span v-if="resultContext(r)" class="picker-context">{{ resultContext(r) }}</span>
            </span>
          </button>
        </li>
        <li v-for="(c, i) in creates" :key="c.kind">
          <button
            type="button"
            class="picker-item create"
            :class="{ hl: i + results.length === highlight }"
            @mousedown.prevent
            @click="create(c.kind)"
          >
            <Icon name="plus" :size="18" />
            <span class="picker-text"><span class="picker-label">{{ c.label }}</span></span>
          </button>
        </li>
        <li v-if="!results.length && !creates.length" class="picker-empty">
          {{ trimmed ? 'Nothing matches.' : 'Type to search.' }}
        </li>
      </ul>
    </div>
  </Teleport>
</template>
