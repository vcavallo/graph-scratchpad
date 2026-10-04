<script setup lang="ts">
// Full-screen picker. Link mode: search, tap a result to pick it. Move mode:
// browse like folders (tapping a row opens it; search results open too) and
// confirm with "Move into …", so nothing moves by surprise.

import { computed, nextTick, ref, watch } from 'vue'
import Icon from './Icon.vue'
import KindIcon from './KindIcon.vue'
import { api } from '@/db/api'
import type { BrowseRow, Crumb, Kind, SearchResult } from '@/db/types'
import { closePicker, pickerState, reportError, type PickResult } from '@/state/ui'
import { resultContext } from '@/lib/kinds'

const q = ref('')
const results = ref<SearchResult[]>([])
const highlight = ref(0)
const input = ref<HTMLInputElement>()
let seq = 0

// Move-mode browsing: the trail of nodes opened so far (empty = all pads).
const trail = ref<Crumb[]>([])
const rows = ref<BrowseRow[]>([])
const browseLoading = ref(false)
let browseSeq = 0

const req = pickerState
const trimmed = computed(() => q.value.trim())
const isMove = computed(() => req.value?.mode === 'move')
const browsing = computed(() => isMove.value && !trimmed.value)
const excluded = computed(() => new Set(req.value?.excludeIds ?? []))
const here = computed(() => trail.value.at(-1) ?? null)

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

watch(req, async (r) => {
  if (!r) return
  q.value = ''
  results.value = []
  highlight.value = 0
  trail.value = []
  rows.value = []
  if (r.mode === 'move') {
    // Start next to the node being moved: its siblings are the likeliest targets.
    if (r.startNear) {
      try {
        trail.value = await api.getAncestors(r.startNear)
      } catch {
        trail.value = []
      }
    }
    await browse()
  } else {
    void search()
    void nextTick(() => input.value?.focus())
  }
})

watch(q, () => {
  if (!isMove.value || trimmed.value) void search()
})

async function browse() {
  const my = ++browseSeq
  browseLoading.value = true
  try {
    const r = await api.listBrowse(here.value?.id ?? null)
    if (my === browseSeq) rows.value = r
  } catch (e) {
    reportError(e)
  } finally {
    if (my === browseSeq) browseLoading.value = false
  }
}

function open(row: { id: string; kind: Kind; label: string }) {
  if (excluded.value.has(row.id)) return
  trail.value = [...trail.value, { id: row.id, kind: row.kind, label: row.label }]
  void browse()
}

function goTo(index: number) {
  trail.value = trail.value.slice(0, index + 1)
  void browse()
}

async function openResult(r: SearchResult) {
  try {
    const crumbs = await api.getAncestors(r.id)
    trail.value = [...crumbs, { id: r.id, kind: r.kind, label: r.label }]
  } catch (e) {
    reportError(e)
    return
  }
  q.value = ''
  input.value?.blur()
  void browse()
}

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
  if (isMove.value) void openResult(res)
  else finish({ id: res.id, kind: res.kind, label: res.label })
}

function moveHere() {
  const h = here.value
  if (h) finish({ id: h.id, kind: h.kind, label: h.label })
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
    if (browsing.value) return moveHere()
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

      <template v-if="browsing">
        <nav class="picker-trail" aria-label="Location">
          <button type="button" :class="{ on: !trail.length }" @click="goTo(-1)">All pads</button>
          <template v-for="(c, i) in trail" :key="c.id">
            <span class="sep">›</span>
            <button type="button" :class="{ on: i === trail.length - 1 }" @click="goTo(i)">
              {{ c.label || 'Untitled' }}
            </button>
          </template>
        </nav>
        <button v-if="here" type="button" class="btn btn-primary picker-here" @click="moveHere">
          <Icon name="move" :size="18" />
          <span class="picker-here-label">Move into “{{ here.label || 'Untitled' }}”</span>
        </button>
        <ul class="picker-results" role="listbox">
          <li v-for="r in rows" :key="r.id">
            <button
              type="button"
              class="picker-item"
              :class="{ done: r.done, excluded: excluded.has(r.id) }"
              :disabled="excluded.has(r.id)"
              @click="open(r)"
            >
              <KindIcon :kind="r.kind" />
              <span class="picker-text">
                <span class="picker-label">{{ r.label || 'Untitled' }}</span>
                <span v-if="excluded.has(r.id)" class="picker-context">The item you’re moving</span>
              </span>
              <span v-if="r.childCount && !excluded.has(r.id)" class="picker-count">{{ r.childCount }}</span>
              <Icon v-if="!excluded.has(r.id)" name="chevron-right" :size="18" />
            </button>
          </li>
          <li v-if="!browseLoading && !rows.length" class="picker-empty">
            {{ here ? 'Nothing inside yet. Move it here to start a list.' : 'No pads yet.' }}
          </li>
        </ul>
      </template>

      <ul v-else class="picker-results" role="listbox">
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
            <Icon v-if="isMove" name="chevron-right" :size="18" />
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
