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
import type { TreeNode } from '@/db/types'
import * as T from '@/lib/treeOps'
import type { CaretTarget, LineMarker, PastedLine, PastedRest, Shortcut } from '@/lib/editorDom'
import { openLinkPicker } from '@/lib/linking'
import { editing, focusEditor, getEditor } from '@/state/focus'
import { openPicker, openSheet, pickerState, reportError, toast, type SheetAction } from '@/state/ui'
import { refCache } from '@/state/refs'
import { labelize } from '@/lib/tokens'
import { categoryById } from '@/state/categories'
import { chooseCategory } from '@/lib/contextActions'
import { sendActions } from '@/lib/sendTo'
import { noteToFact } from '@/lib/factActions'
import { placeOn, type VimPlace, type VimRowAction } from '@/lib/vim'
import { vim, vimInsert, type YankedLine } from '@/state/vim'
import { vimOpen } from '@/lib/vimJumps'
import { parseTokens } from '@/lib/tokens'

const props = withDefaults(defineProps<{ root: TreeNode; reload: () => Promise<void>; addLabel?: string }>(), {
  addLabel: 'item',
})
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
    task: r.node.kind === 'item' ? r.node.task : null,
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

/** Remove a row from the local tree; its editor must not save on unmount. */
function removeLocal(id: string) {
  getEditor(key(id))?.discard()
  T.remove(local.value, id)
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
  if (!after) return openBelow(row)
  const nid = crypto.randomUUID()
  // A new line is a to-do if the line it comes from is one.
  const task = T.taskFor(T.locate(local.value, id)?.parent ?? local.value, row.node)
  if (!before) {
    void ed?.flush()
    T.insertSibling(local.value, id, 'before', T.newNode(nid, { task }))
    sync(api.createSibling(id, 'before', { id: nid, task }))
  } else {
    ed?.replace(before, { saved: true })
    row.node.text = before
    T.insertSibling(local.value, id, 'after', T.newNode(nid, { text: after, task }))
    sync(api.splitNode(id, before, after, nid))
    focusRow(nid, 'start')
  }
}

/** A new line right below this one: its first child when it's open, else its next sibling. */
function openBelow(row: T.FlatRow): string {
  const id = row.node.id
  const nid = crypto.randomUUID()
  void getEditor(key(id))?.flush()
  if (row.hasChildren && !row.node.collapsed) {
    const firstTask = T.taskFor(row.node, row.node.children[0])
    T.insertChild(local.value, id, 'first', T.newNode(nid, { task: firstTask }))
    sync(api.createChild(id, null, { id: nid, task: firstTask }))
  } else {
    // A new line is a to-do if the line it comes from is one.
    const task = T.taskFor(T.locate(local.value, id)?.parent ?? local.value, row.node)
    T.insertSibling(local.value, id, 'after', T.newNode(nid, { task }))
    sync(api.createSibling(id, 'after', { id: nid, task }))
  }
  focusRow(nid, 'start')
  return nid
}

/** A new line just above this one, focused (vim's O). */
function openAbove(row: T.FlatRow): string {
  const id = row.node.id
  const nid = crypto.randomUUID()
  const task = T.taskFor(T.locate(local.value, id)?.parent ?? local.value, row.node)
  void getEditor(key(id))?.flush()
  T.insertSibling(local.value, id, 'before', T.newNode(nid, { task }))
  sync(api.createSibling(id, 'before', { id: nid, task }))
  focusRow(nid, 'start')
  return nid
}

/** Where a line is: its parent and the sibling before it, so it can go back there. */
function placeOf(id: string): { parent: string; after: string | null } {
  const at = T.locate(local.value, id)
  const parent = at?.parent ?? local.value
  return { parent: parent.id, after: at && at.index > 0 ? parent.children[at.index - 1].id : null }
}

/** A copy of a line and what's inside it, as it reads now. */
function yanked(n: TreeNode): YankedLine {
  return {
    id: n.id,
    text: getEditor(key(n.id))?.text() ?? n.text,
    task: n.task,
    done: n.done,
    numbered: n.numbered,
    children: n.children.map(yanked),
  }
}

function copyOf(l: YankedLine): PastedItem {
  return { ...l, id: crypto.randomUUID(), children: l.children.map(copyOf) }
}

/** vim's p and P: the yanked line goes where o or O would open one. */
async function put(row: T.FlatRow, where: 'below' | 'above') {
  const reg = vim.register
  if (!reg) return toast('Nothing to put yet: yy copies a line, dd cuts one.')
  const to =
    where === 'below' && row.hasChildren && !row.node.collapsed
      ? { parent: row.node.id, after: null }
      : where === 'below'
        ? { parent: placeOf(row.node.id).parent, after: row.node.id }
        : placeOf(row.node.id)
  void getEditor(key(row.node.id))?.flush()
  // The first p after dd moves the line itself here, so links to it still work.
  if (reg.cut) {
    vim.register = { ...reg, cut: false }
    if (await api.restoreTo(reg.line.id, to.parent, to.after).catch(() => false)) {
      vim.undo = { kind: 'remove', id: reg.line.id }
      await props.reload()
      focusRow(reg.line.id, 'start')
      return
    }
  }
  const item = copyOf(reg.line)
  const node = pastedNode(item)
  if (to.after) T.insertSibling(local.value, to.after, 'after', node)
  else T.insertChild(local.value, to.parent, 'first', node)
  sync(api.insertMany(to.after ? { after: to.after } : { parent: to.parent, position: 'first' }, [item]))
  vim.undo = { kind: 'remove', id: item.id }
  focusRow(item.id, 'start')
}

/** vim's u: one step back. u again redoes it, as in the original vi. */
function vimUndo() {
  const u = vim.undo
  if (!u) return toast('Nothing to undo')
  switch (u.kind) {
    case 'text': {
      const ed = getEditor(key(u.id)) ?? getEditor(`title:${u.id}`)
      vim.undo = { kind: 'text', id: u.id, text: ed?.text() ?? T.locate(local.value, u.id)?.node.text ?? '' }
      if (ed) ed.replace(u.text, { caret: Math.min(ed.caret() ?? 0, u.text.length) })
      else sync(api.updateText(u.id, u.text))
      return
    }
    case 'restore':
      vim.undo = { kind: 'remove', id: u.id }
      sync(api.restoreSubtree(u.id))
      focusRow(u.id, 'start')
      return
    case 'remove': {
      vim.undo = { kind: 'restore', id: u.id }
      const i = rows.value.findIndex((r) => r.node.id === u.id)
      const inside = i >= 0 ? T.subtreeIds(rows.value[i].node) : []
      const near = i >= 0 ? (rows.value[i - 1] ?? rows.value.slice(i + 1).find((r) => !inside.includes(r.node.id))) : undefined
      removeLocal(u.id)
      sync(api.deleteSubtree(u.id))
      if (near) focusRow(near.node.id, 'start')
      return
    }
    case 'place':
      // Redo needs to know where it is now; off this page, it's a one-way trip.
      vim.undo = T.locate(local.value, u.id) ? { kind: 'place', id: u.id, ...placeOf(u.id) } : null
      sync(api.moveSubtree(u.id, u.parent, u.after))
      refocus(u.id, caretOf(u.id))
      return
  }
}

/** Vim keys that reach past the line: move between lines, open, delete, indent, fold. */
function onVim(row: T.FlatRow, a: VimRowAction) {
  const i = rows.value.findIndex((r) => r.node.id === row.node.id)
  const go = (r: T.FlatRow | undefined, place: VimPlace) => {
    if (!r) return false
    focusEditor(key(r.node.id), placeOn(getEditor(key(r.node.id))?.text() ?? r.node.text, place))
    return true
  }
  switch (a.action) {
    case 'down':
      return void go(rows.value[i + 1], a.place)
    case 'up':
      if (!go(rows.value[i - 1], a.place)) emit('exitTop')
      return
    case 'first':
      return void go(rows.value[0], 'start')
    case 'last':
      return void go(rows.value[rows.value.length - 1], 'start')
    case 'open-below':
      vim.undo = { kind: 'remove', id: openBelow(row) }
      return
    case 'open-above':
      vim.undo = { kind: 'remove', id: openAbove(row) }
      return
    case 'delete':
      vim.register = { line: yanked(row.node), cut: true }
      vim.undo = { kind: 'restore', id: row.node.id }
      return deleteRow(row.node.id)
    case 'yank':
      vim.register = { line: yanked(row.node), cut: false }
      return
    case 'put-below':
    case 'put-above':
      return void put(row, a.action === 'put-below' ? 'below' : 'above')
    case 'undo':
      return vimUndo()
    case 'open':
      return vimOpen(`/n/${a.link ?? row.node.ref ?? row.node.id}`)
    case 'indent':
    case 'outdent': {
      const was = { kind: 'place' as const, id: row.node.id, ...placeOf(row.node.id) }
      if (a.action === 'indent' ? doIndent(row.node.id) : doOutdent(row.node.id)) vim.undo = was
      return
    }
    case 'fold':
    case 'unfold':
    case 'fold-toggle':
      return setCollapsed(row, a.action === 'fold' || (a.action === 'fold-toggle' && !row.node.collapsed))
  }
}

const merging = new Set<string>()

async function onBackspaceStart(row: T.FlatRow, { empty }: { empty: boolean }) {
  const id = row.node.id
  const i = rows.value.findIndex((r) => r.node.id === id)
  const prev = rows.value[i - 1]
  const next = rows.value[i + 1]
  if (row.hasChildren || merging.has(id)) return
  if (empty) {
    removeLocal(id)
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
  // Key repeat can deliver a second Backspace before the merge lands.
  merging.add(id)
  try {
    await ed?.flush()
    await prevEd?.flush()
    const ok = await api.mergeInto(id, prev.node.id)
    if (!ok) {
      toast('Can’t merge: other items link to this one')
      return
    }
    prev.node.text = prevText + text
    removeLocal(id)
    await nextTick()
    const pe = getEditor(key(prev.node.id))
    pe?.replace(prevText + text, { saved: true })
    focusEditor(key(prev.node.id), prevText.length)
  } catch (e) {
    reportError(e)
  } finally {
    merging.delete(id)
    void props.reload()
  }
}

function doIndent(id: string): boolean {
  const caret = caretOf(id)
  void getEditor(key(id))?.flush()
  if (!T.indent(local.value, id)) return false
  sync(api.indent(id))
  refocus(id, caret)
  return true
}

function doOutdent(id: string): boolean {
  const caret = caretOf(id)
  void getEditor(key(id))?.flush()
  if (!T.outdent(local.value, id)) return false
  sync(api.outdent(id))
  refocus(id, caret)
  return true
}

function doMove(id: string, dir: 'up' | 'down') {
  const caret = caretOf(id)
  void getEditor(key(id))?.flush()
  if (dir === 'up' ? !T.moveUp(local.value, id) : !T.moveDown(local.value, id)) return
  sync(dir === 'up' ? api.moveUp(id) : api.moveDown(id))
  refocus(id, caret)
}

function toggleDone(row: T.FlatRow) {
  const n = row.node
  if (n.kind !== 'item') return
  n.done = !n.done
  if (n.done) n.task = true // checking off a bullet makes it a to-do
  // A line that's only a link is that item: check off the item itself.
  sync(api.setDone(n.ref ?? n.id, n.done))
}

/** Switch a line between a to-do (checkbox) and a plain bullet. */
function setTask(n: TreeNode, task: boolean, done = false) {
  if (n.kind !== 'item') return
  const wasDone = n.done
  if (n.task === task && wasDone === (task && done)) return
  n.task = task
  n.done = task && done
  const id = n.ref ?? n.id // a line that's only a link changes the item itself
  if (n.done) sync(api.setDone(id, true))
  else if (task && wasDone) sync(api.setDone(id, false))
  else sync(api.setTask(id, task)) // becoming a bullet also unchecks it
}

function toggleTask(row: T.FlatRow) {
  setTask(row.node, !row.node.task)
}

function onMarker(row: T.FlatRow, m: LineMarker) {
  if (m.numbered) numberListOf(row.node.id)
  if (m.task !== undefined) setTask(row.node, m.task, m.done)
}

/** "1. " typed or pasted on a line: the list it's in becomes a numbered list. */
function numberListOf(id: string) {
  const parent = T.locate(local.value, id)?.parent
  if (parent && !parent.numbered) setNumbered(parent, true)
}

function setChildrenTask(n: TreeNode, task: boolean) {
  for (const c of n.children) {
    if (c.kind !== 'item') continue
    c.task = task
    if (!task) c.done = false
  }
  sync(api.setChildrenTask(n.id, task))
}

/** True when every item directly inside is a to-do (and there is at least one item). */
function allTasks(n: TreeNode): boolean {
  const items = n.children.filter((c) => c.kind === 'item')
  return items.length > 0 && items.every((c) => c.task)
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
    case 'toggle-task':
      return toggleTask(row)
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

interface PastedItem {
  id: string
  text: string
  task: boolean
  done: boolean
  numbered: boolean
  children: PastedItem[]
}

/**
 * Pasted lines keep what their markers said (to-do or note); a line without
 * one follows the line before it, and the first line of a list follows
 * `task` (the line it's under, or the line it's pasted after).
 */
function pastedItems(lines: PastedLine[], task: boolean): PastedItem[] {
  let prev = task
  return lines.map((l) => {
    const t = l.task ?? prev
    prev = t
    return {
      id: crypto.randomUUID(),
      text: l.text,
      task: t,
      done: t && !!l.done,
      numbered: l.children.some((c) => c.numbered),
      children: pastedItems(l.children, t),
    }
  })
}

function pastedNode(it: PastedItem): TreeNode {
  const n = T.newNode(it.id, it)
  n.numbered = it.numbered
  n.children = it.children.map(pastedNode)
  return n
}

/** The last line of pasted items, as they read: the deepest last one. */
function lastPasted(items: PastedItem[]): string | undefined {
  const it = items[items.length - 1]
  return it && (lastPasted(it.children) ?? it.id)
}

/** Put pasted items in the local tree: as `parent`'s first children, or after `sibling`. */
function placePasted(items: PastedItem[], at: { parent: TreeNode } | { after: string }) {
  items.forEach((it, i) => {
    const node = pastedNode(it)
    if (i > 0) T.insertSibling(local.value, items[i - 1].id, 'after', node)
    else if ('parent' in at) T.insertChild(local.value, at.parent.id, 'first', node)
    else T.insertSibling(local.value, at.after, 'after', node)
  })
}

/** A paste of several lines into a row: its first line is already in the row; the rest keep their shape. */
function onPasteLines(row: T.FlatRow, rest: PastedRest) {
  void getEditor(key(row.node.id))?.flush()
  const n = row.node
  // Lines indented under the first one go under this row, before its own children.
  const inside = pastedItems(rest.inside, T.taskFor(n, n.children[0] ?? n))
  if (inside.length) {
    if (rest.inside.some((l) => l.numbered) && !n.numbered) setNumbered(n, true)
    if (n.collapsed) sync(api.setCollapsed(n.id, false))
    placePasted(inside, { parent: n })
    sync(api.insertMany({ parent: n.id, position: 'first' }, inside))
  }
  const after = pastedItems(rest.after, T.taskFor(T.locate(local.value, n.id)?.parent ?? local.value, n))
  if (after.length) {
    if (rest.after.some((l) => l.numbered)) numberListOf(n.id)
    placePasted(after, { after: n.id })
    sync(api.insertMany({ after: n.id }, after))
  }
  const last = lastPasted(after) ?? lastPasted(inside)
  if (last) focusRow(last, 'end')
}

function deleteRow(id: string) {
  const i = rows.value.findIndex((r) => r.node.id === id)
  const row = rows.value[i]
  if (!row) return
  const label = labelOf(row.node)
  const prev = rows.value[i - 1]
  const nextRow = rows.value.slice(i + 1).find((r) => r.depth <= row.depth)
  removeLocal(id)
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
    placeholder: 'Search, or browse below',
    excludeIds: T.subtreeIds(row.node),
    startNear: id,
    onPick: (r) => {
      api
        .moveSubtree(id, r.id)
        .then(() => {
          removeLocal(id)
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

function setNumbered(n: TreeNode, numbered: boolean) {
  n.numbered = numbered
  sync(api.setNumbered(n.id, numbered))
}

function openMore(row: T.FlatRow) {
  const n = row.node
  const actions: SheetAction[] = [
    { label: 'Open', icon: 'open', run: () => router.push(`/n/${n.id}`) },
    { label: 'Move to…', icon: 'move', run: () => moveTo(row) },
    // Pull it into another list too (Today…), as a line that's only a link to it.
    // (A line that’s only a link sends the item it links to.)
    ...sendActions({ id: n.ref ?? n.id, label: labelOf(n) }, T.subtreeIds(n)),
  ]
  // A note that links to something can become a fact about what it's under.
  const under = T.locate(local.value, n.id)?.parent
  if (under && parseTokens(n.text).length && !n.ref) {
    actions.push({
      label: `Make it a fact about “${labelOf(under)}”`,
      icon: 'linked',
      run: () => {
        const ed = getEditor(key(n.id))
        void ed?.flush()
        noteToFact({ id: n.id, text: ed?.text() ?? n.text }, { id: under.id, label: labelOf(under) })
      },
    })
  }
  if (row.hasChildren) {
    actions.push(
      {
        label: n.collapsed ? 'Expand' : 'Collapse',
        icon: 'collapse',
        run: () => setCollapsed(row, !n.collapsed),
      },
      {
        label: n.numbered ? 'Use bullets for the items inside' : 'Number the items inside',
        icon: n.numbered ? 'list' : 'numbered',
        run: () => setNumbered(n, !n.numbered),
      },
    )
    if (n.children.some((c) => c.kind === 'item')) {
      const all = allTasks(n)
      actions.push({
        label: all ? 'Remove checkboxes from the items inside' : 'Add checkboxes to the items inside',
        icon: all ? 'list' : 'checkbox',
        run: () => setChildrenTask(n, !all),
      })
    }
  }
  if (n.kind === 'item' || n.kind === 'place' || n.kind === 'person') {
    // Any line can be a context (a place, a room, a project…) right where it is.
    const cat = categoryById(n.category)
    actions.push(
      cat
        ? { label: `Change kind (${cat.name})…`, icon: cat.icon, run: () => chooseCategory(n.id, labelOf(n), n.category) }
        : { label: 'Make it a context…', icon: 'grid', run: () => chooseCategory(n.id, labelOf(n), null) },
    )
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
  vimInsert()
  const nid = crypto.randomUUID()
  const kids = local.value.children
  const task = T.taskFor(local.value, position === 'first' ? kids[0] : kids[kids.length - 1])
  T.insertChild(local.value, local.value.id, position, T.newNode(nid, { task }))
  sync(api.createChild(local.value.id, position === 'first' ? null : undefined, { id: nid, task }))
  focusRow(nid, 'start')
}

/** Lines pasted into the title become the first items, in order, keeping their shape. */
function addLines(lines: PastedLine[]) {
  if (lines.some((l) => l.numbered) && !local.value.numbered) setNumbered(local.value, true)
  const items = pastedItems(lines, T.taskFor(local.value, local.value.children[0]))
  placePasted(items, { parent: local.value })
  sync(api.insertMany({ parent: local.value.id, position: 'first' }, items))
  const last = lastPasted(items)
  if (last) focusRow(last, 'end')
}

function focusFirst(): boolean {
  const first = rows.value[0]
  if (!first) return false
  focusEditor(key(first.node.id), 'start')
  return true
}

/** The page menu's "checkboxes for this list". */
function setRootChildrenTask(task: boolean) {
  setChildrenTask(local.value, task)
}

defineExpose({ addChild, addLines, focusFirst, setRootChildrenTask, vimUndo })
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
      @marker="onMarker"
      @vim="onVim"
      @links="(r) => router.push({ path: `/n/${r.node.id}`, query: { show: 'links' } })"
    />
    <button type="button" class="add-row" @click="addChild('last')">
      <Icon name="plus" :size="18" />
      <span>{{ rows.length ? `Add ${addLabel}` : `Add the first ${addLabel}` }}</span>
    </button>
    <Teleport to="body">
      <EditToolbar
        v-if="toolbarState && !pickerState"
        v-bind="toolbarState"
        :vim="vim.enabled ? vim.mode : null"
        @vim-mode="vim.mode = vim.mode === 'normal' ? 'insert' : 'normal'"
        @outdent="doOutdent(activeRow!.node.id)"
        @indent="doIndent(activeRow!.node.id)"
        @up="doMove(activeRow!.node.id, 'up')"
        @down="doMove(activeRow!.node.id, 'down')"
        @link="onToolbarLink"
        @task="toggleTask(activeRow!)"
        @more="openMore(activeRow!)"
        @close="closeKeyboard"
      />
    </Teleport>
  </div>
</template>
