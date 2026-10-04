<script setup lang="ts">
// The editable outline under a node. Keeps a local copy of the tree and
// applies operations to it immediately (so focus can move inside the key
// handler and the Android keyboard stays up), then sends the same operation
// to the worker and reloads. The reload's result replaces the local copy.

import { computed, nextTick, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import OutlineRow from './OutlineRow.vue'
import EditToolbar from './EditToolbar.vue'
import Icon from './Icon.vue'
import { api } from '@/db/api'
import type { Kind, TreeNode } from '@/db/types'
import * as T from '@/lib/treeOps'
import type { CaretTarget, Shortcut } from '@/lib/editorDom'
import { openLinkPicker } from '@/lib/linking'
import { editing, focusEditor, getEditor } from '@/state/focus'
import { openPicker, openSheet, pickerState, reportError, toast, type SheetAction } from '@/state/ui'
import { refCache } from '@/state/refs'
import { labelize } from '@/lib/tokens'

const props = defineProps<{ root: TreeNode; reload: () => Promise<void> }>()
const emit = defineEmits<{ exitTop: [] }>()
const router = useRouter()

const clone = (t: TreeNode): TreeNode => JSON.parse(JSON.stringify(t))
const local = ref<TreeNode>(clone(props.root))
watch(
  () => props.root,
  (r) => {
    local.value = clone(r)
  },
)

const rows = computed(() => T.flatten(local.value))
const key = (id: string) => `row:${id}`

const activeRow = computed(() => {
  const k = editing.key
  if (!k?.startsWith('row:')) return null
  return rows.value.find((r) => r.node.id === k.slice(4)) ?? null
})

const toolbarState = computed(() => {
  const r = activeRow.value
  if (!r) return null
  const at = T.locate(local.value, r.node.id)
  const index = at?.index ?? 0
  const siblings = at?.parent?.children.length ?? 1
  return {
    canIndent: index > 0,
    canOutdent: r.depth > 0,
    canUp: index > 0,
    canDown: index < siblings - 1,
  }
})

function sync(p: Promise<unknown>): void {
  p.catch(reportError).finally(() => void props.reload())
}

function caretOf(id: string): CaretTarget {
  return getEditor(key(id))?.caret() ?? 'end'
}

function focusRow(id: string, at: CaretTarget) {
  void nextTick(() => focusEditor(key(id), at))
}

/** After a move the row's DOM node may have been re-parented; put focus back. */
function refocus(id: string, at: CaretTarget) {
  void nextTick(() => {
    const ed = getEditor(key(id))
    if (ed && !ed.isFocused()) ed.focus(at)
  })
}

function labelOf(n: TreeNode): string {
  const l = labelize(n.text, (id) => refCache[id]?.label).trim()
  return l.length > 40 ? l.slice(0, 39) + '…' : l || 'Untitled'
}

// ------------------------------------------------------------ operations

async function saveText(id: string, text: string) {
  const at = T.locate(local.value, id)
  if (at) at.node.text = text
  await api.updateText(id, text)
  void props.reload()
}

function onEnter(row: T.FlatRow, { before, after }: { before: string; after: string }) {
  const id = row.node.id
  const ed = getEditor(key(id))
  if (!before && !after && row.depth > 0 && row.isLast) {
    doOutdent(id)
    return
  }
  const nid = crypto.randomUUID()
  if (!after) {
    void ed?.flush()
    if (row.hasChildren && !row.node.collapsed) {
      T.insertChild(local.value, id, 'first', T.newNode(nid))
      sync(api.createChild(id, null, { id: nid }))
    } else {
      T.insertSibling(local.value, id, 'after', T.newNode(nid))
      sync(api.createSibling(id, 'after', { id: nid }))
    }
    focusRow(nid, 'start')
  } else if (!before) {
    void ed?.flush()
    T.insertSibling(local.value, id, 'before', T.newNode(nid))
    sync(api.createSibling(id, 'before', { id: nid }))
  } else {
    ed?.replace(before, { saved: true })
    row.node.text = before
    T.insertSibling(local.value, id, 'after', T.newNode(nid, after))
    sync(api.splitNode(id, before, after, nid))
    focusRow(nid, 'start')
  }
}

async function onBackspaceStart(row: T.FlatRow, { empty }: { empty: boolean }) {
  const id = row.node.id
  const i = rows.value.findIndex((r) => r.node.id === id)
  const prev = rows.value[i - 1]
  const next = rows.value[i + 1]
  if (row.hasChildren) return
  if (empty) {
    T.remove(local.value, id)
    sync(api.deleteSubtree(id))
    if (prev) focusRow(prev.node.id, 'end')
    else if (next) focusRow(next.node.id, 'start')
    else emit('exitTop')
    return
  }
  if (!prev) return
  const ed = getEditor(key(id))
  const prevEd = getEditor(key(prev.node.id))
  const text = ed?.text() ?? row.node.text
  const prevText = prevEd?.text() ?? prev.node.text
  await ed?.flush()
  await prevEd?.flush()
  try {
    const ok = await api.mergeInto(id, prev.node.id)
    if (!ok) {
      toast('Can’t merge: other items link to this one')
      return
    }
    prev.node.text = prevText + text
    T.remove(local.value, id)
    await nextTick()
    const pe = getEditor(key(prev.node.id))
    pe?.replace(prevText + text, { saved: true })
    focusEditor(key(prev.node.id), prevText.length)
  } catch (e) {
    reportError(e)
  } finally {
    void props.reload()
  }
}

function doIndent(id: string) {
  const caret = caretOf(id)
  void getEditor(key(id))?.flush()
  if (!T.indent(local.value, id)) return
  sync(api.indent(id))
  refocus(id, caret)
}

function doOutdent(id: string) {
  const caret = caretOf(id)
  void getEditor(key(id))?.flush()
  if (!T.outdent(local.value, id)) return
  sync(api.outdent(id))
  refocus(id, caret)
}

function doMove(id: string, dir: 'up' | 'down') {
  const caret = caretOf(id)
  void getEditor(key(id))?.flush()
  if (dir === 'up' ? !T.moveUp(local.value, id) : !T.moveDown(local.value, id)) return
  sync(dir === 'up' ? api.moveUp(id) : api.moveDown(id))
  refocus(id, caret)
}

function toggleDone(row: T.FlatRow) {
  row.node.done = !row.node.done
  sync(api.setDone(row.node.id, row.node.done))
}

function setCollapsed(row: T.FlatRow, collapsed: boolean) {
  if (!row.hasChildren || row.node.collapsed === collapsed) return
  const active = activeRow.value
  const hidesActive =
    collapsed && active && active.node.id !== row.node.id && T.subtreeIds(row.node).includes(active.node.id)
  row.node.collapsed = collapsed
  sync(api.setCollapsed(row.node.id, collapsed))
  if (hidesActive) focusRow(row.node.id, 'end')
}

function onArrow(row: T.FlatRow, dir: 'up' | 'down') {
  const i = rows.value.findIndex((r) => r.node.id === row.node.id)
  const target = rows.value[dir === 'up' ? i - 1 : i + 1]
  if (target) focusEditor(key(target.node.id), dir === 'up' ? 'end' : 'start')
  else if (dir === 'up') emit('exitTop')
}

function onShortcut(row: T.FlatRow, name: Shortcut) {
  switch (name) {
    case 'toggle-done':
      return toggleDone(row)
    case 'move-up':
      return doMove(row.node.id, 'up')
    case 'move-down':
      return doMove(row.node.id, 'down')
    case 'collapse':
      return setCollapsed(row, true)
    case 'expand':
      return setCollapsed(row, false)
  }
}

function onPasteLines(row: T.FlatRow, lines: string[]) {
  let after = row.node.id
  const ids: string[] = []
  void getEditor(key(after))?.flush()
  const send = async () => {
    for (const [i, text] of lines.entries()) {
      await api.createSibling(i === 0 ? row.node.id : ids[i - 1], 'after', { id: ids[i], text })
    }
  }
  for (const text of lines) {
    const nid = crypto.randomUUID()
    T.insertSibling(local.value, after, 'after', T.newNode(nid, text))
    ids.push(nid)
    after = nid
  }
  sync(send())
  focusRow(after, 'end')
}

function deleteRow(id: string) {
  const i = rows.value.findIndex((r) => r.node.id === id)
  const row = rows.value[i]
  if (!row) return
  const label = labelOf(row.node)
  const prev = rows.value[i - 1]
  const nextRow = rows.value.slice(i + 1).find((r) => r.depth <= row.depth)
  T.remove(local.value, id)
  api
    .deleteSubtree(id)
    .then(({ count }) => {
      toast(count > 1 ? `Deleted “${label}” and ${count - 1} more` : `Deleted “${label}”`, {
        action: { label: 'Undo', run: () => sync(api.restoreSubtree(id)) },
      })
    })
    .catch(reportError)
    .finally(() => void props.reload())
  if (prev) focusRow(prev.node.id, 'end')
  else if (nextRow) focusRow(nextRow.node.id, 'start')
}

function moveTo(row: T.FlatRow) {
  const id = row.node.id
  const at = T.locate(local.value, id)
  const oldParent = at?.parent?.id
  const oldPrev = at && at.index > 0 ? at.parent!.children[at.index - 1].id : null
  ;(document.activeElement as HTMLElement | null)?.blur()
  openPicker({
    mode: 'move',
    title: `Move “${labelOf(row.node)}” to`,
    placeholder: 'Search pads and items',
    excludeIds: T.subtreeIds(row.node),
    emptyKinds: ['pad'],
    onPick: (r) => {
      api
        .moveSubtree(id, r.id)
        .then(() => {
          T.remove(local.value, id)
          toast(`Moved to “${r.label}”`, {
            action: oldParent
              ? { label: 'Undo', run: () => sync(api.moveSubtree(id, oldParent, oldPrev)) }
              : undefined,
          })
        })
        .catch(reportError)
        .finally(() => void props.reload())
    },
  })
}

function setKind(row: T.FlatRow, kind: Kind) {
  row.node.kind = kind
  sync(api.setKind(row.node.id, kind))
}

function openMore(row: T.FlatRow) {
  const n = row.node
  const actions: SheetAction[] = [
    { label: 'Open', icon: 'open', run: () => router.push(`/n/${n.id}`) },
    { label: 'Move to…', icon: 'move', run: () => moveTo(row) },
  ]
  if (row.hasChildren) {
    actions.push({
      label: n.collapsed ? 'Expand' : 'Collapse',
      icon: 'collapse',
      run: () => setCollapsed(row, !n.collapsed),
    })
  }
  for (const k of ['item', 'place', 'person'] as Kind[]) {
    if (k !== n.kind) {
      actions.push({
        label: k === 'item' ? 'Make it a plain item' : `Make it a ${k}`,
        icon: k === 'item' ? 'dot' : k === 'place' ? 'pin' : 'person',
        run: () => setKind(row, k),
      })
    }
  }
  actions.push({ label: 'Delete', icon: 'trash', danger: true, run: () => deleteRow(n.id) })
  openSheet({ title: labelOf(n), actions })
}

function onToolbarLink() {
  const r = activeRow.value
  if (!r) return
  const ed = getEditor(key(r.node.id))
  openLinkPicker(key(r.node.id), ed?.caret() ?? (ed?.text().length ?? 0), false, r.node.id)
}

function closeKeyboard() {
  ;(document.activeElement as HTMLElement | null)?.blur()
}

function onChip(id: string) {
  void router.push(`/n/${id}`)
}

// ----------------------------------------------------------- public API

/** Add a new first child (Enter in the title) or last child (the add button). */
function addChild(position: 'first' | 'last') {
  const nid = crypto.randomUUID()
  T.insertChild(local.value, local.value.id, position, T.newNode(nid))
  sync(api.createChild(local.value.id, position === 'first' ? null : undefined, { id: nid }))
  focusRow(nid, 'start')
}

function focusFirst(): boolean {
  const first = rows.value[0]
  if (!first) return false
  focusEditor(key(first.node.id), 'start')
  return true
}

defineExpose({ addChild, focusFirst })
</script>

<template>
  <div class="outline">
    <OutlineRow
      v-for="row in rows"
      :key="row.node.id"
      :row="row"
      :active="activeRow?.node.id === row.node.id"
      :save="saveText"
      @enter="onEnter"
      @backspace-start="onBackspaceStart"
      @tab="(r, shift) => (shift ? doOutdent(r.node.id) : doIndent(r.node.id))"
      @arrow="onArrow"
      @shortcut="onShortcut"
      @at-trigger="(r, offset) => openLinkPicker(key(r.node.id), offset, true, r.node.id)"
      @chip="onChip"
      @paste-lines="onPasteLines"
      @toggle="(r) => setCollapsed(r, !r.node.collapsed)"
      @done="toggleDone"
    />
    <button type="button" class="add-row" @click="addChild('last')">
      <Icon name="plus" :size="18" />
      <span>{{ rows.length ? 'Add item' : 'Add the first item' }}</span>
    </button>
    <Teleport to="body">
      <EditToolbar
        v-if="toolbarState && !pickerState"
        v-bind="toolbarState"
        @outdent="doOutdent(activeRow!.node.id)"
        @indent="doIndent(activeRow!.node.id)"
        @up="doMove(activeRow!.node.id, 'up')"
        @down="doMove(activeRow!.node.id, 'down')"
        @link="onToolbarLink"
        @more="openMore(activeRow!)"
        @close="closeKeyboard"
      />
    </Teleport>
  </div>
</template>
