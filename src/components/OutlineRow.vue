<script setup lang="ts">
import { computed } from 'vue'
import EditableText from './EditableText.vue'
import Icon from './Icon.vue'
import KindIcon from './KindIcon.vue'
import type { FlatRow } from '@/lib/treeOps'
import type { Shortcut } from '@/lib/editorDom'

const props = defineProps<{ row: FlatRow; active: boolean; save: (id: string, text: string) => Promise<unknown> }>()
const emit = defineEmits<{
  enter: [row: FlatRow, parts: { before: string; after: string }]
  backspaceStart: [row: FlatRow, info: { empty: boolean }]
  tab: [row: FlatRow, shift: boolean]
  arrow: [row: FlatRow, dir: 'up' | 'down']
  shortcut: [row: FlatRow, name: Shortcut]
  atTrigger: [row: FlatRow, offset: number]
  chip: [id: string]
  pasteLines: [row: FlatRow, lines: string[]]
  toggle: [row: FlatRow]
  done: [row: FlatRow]
}>()

const node = computed(() => props.row.node)
const saveText = (t: string) => props.save(node.value.id, t)
</script>

<template>
  <div
    class="row"
    :class="{ active, done: node.done, numbered: row.numbered, [`kind-${node.kind}`]: true }"
    :style="{ '--depth': row.depth }"
    :data-id="node.id"
  >
    <button
      v-if="row.hasChildren"
      type="button"
      class="twisty"
      :class="{ collapsed: node.collapsed }"
      :aria-label="node.collapsed ? 'Expand' : 'Collapse'"
      :aria-expanded="!node.collapsed"
      @mousedown.prevent
      @click="emit('toggle', row)"
    >
      <Icon name="chevron-right" :size="16" :stroke="2.4" />
    </button>
    <RouterLink
      class="bullet"
      :class="{ 'has-hidden': node.collapsed && row.hasChildren }"
      :to="`/n/${node.id}`"
      aria-label="Open item"
      @mousedown.prevent
    >
      <span v-if="row.numbered" class="num">{{ row.index + 1 }}.</span>
      <KindIcon v-else-if="node.kind === 'place' || node.kind === 'person'" :kind="node.kind" :size="16" />
      <span v-else class="dot" />
    </RouterLink>
    <button
      type="button"
      class="check"
      role="checkbox"
      :aria-checked="node.done"
      aria-label="Done"
      @mousedown.prevent
      @click="emit('done', row)"
    >
      <span class="box"><Icon v-if="node.done" name="check" :size="15" :stroke="3" /></span>
    </button>
    <EditableText
      class="row-text"
      :text="node.text"
      :editor-key="`row:${node.id}`"
      :save="saveText"
      label="Item"
      @enter="(p) => emit('enter', row, p)"
      @backspace-start="(i) => emit('backspaceStart', row, i)"
      @tab="(s) => emit('tab', row, s)"
      @arrow="(d) => emit('arrow', row, d)"
      @shortcut="(n) => emit('shortcut', row, n)"
      @at-trigger="(o) => emit('atTrigger', row, o)"
      @chip="(id) => emit('chip', id)"
      @paste-lines="(l) => emit('pasteLines', row, l)"
    />
  </div>
</template>
