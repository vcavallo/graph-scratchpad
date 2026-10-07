<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import EditableText from '@/components/EditableText.vue'
import Outline from '@/components/Outline.vue'
import Backlinks from '@/components/Backlinks.vue'
import RelationLinks from '@/components/RelationLinks.vue'
import FactsList from '@/components/FactsList.vue'
import { addFact } from '@/lib/factActions'
import { pickRelation } from '@/lib/relationActions'
import { NO_RELATION_ID } from '@/db/types'
import { categoryById } from '@/state/categories'
import { chooseCategory } from '@/lib/contextActions'
import { sendActions } from '@/lib/sendTo'
import { copyPage } from '@/lib/copy'
import EditToolbar from '@/components/EditToolbar.vue'
import Icon from '@/components/Icon.vue'
import KindIcon from '@/components/KindIcon.vue'
import { api } from '@/db/api'
import type { Kind, TreeNode } from '@/db/types'
import { useLoader } from '@/composables/useLoader'
import { mergeRefs, refCache } from '@/state/refs'
import { labelize } from '@/lib/tokens'
import { KIND_NAMES } from '@/lib/kinds'
import { subtreeIds } from '@/lib/treeOps'
import { editing, focusEditor } from '@/state/focus'
import { prefs } from '@/state/prefs'
import { openLinkPicker } from '@/lib/linking'
import type { VimRowAction } from '@/lib/vim'
import { vimInsert } from '@/state/vim'
import { vimOpen } from '@/lib/vimJumps'
import { chipClass, chipLabel, type LineMarker, type Shortcut } from '@/lib/editorDom'
import { confirmDialog, openPicker, openSheet, pickerState, promptDialog, reportError, toast, type SheetAction } from '@/state/ui'

const props = defineProps<{ id: string }>()
const route = useRoute()
const router = useRouter()
const outline = ref<InstanceType<typeof Outline>>()

const { data, error, loading, reload } = useLoader(() => api.getNodeView(props.id))

watch(
  data,
  (d) => {
    if (!d) return
    mergeRefs(d.refs)
    if (d.node.kind === 'pad' && !d.node.deleted) prefs.lastPad = d.node.id
  },
  { flush: 'sync' },
)

// Pages that exist mostly to be linked to (places, people, or an item like
// "waiting" with nothing inside) lead with what links here. Decided once per
// visit, so adding the first note doesn't make the page jump.
const linksFirst = ref(false)
let decided = false
watch(
  data,
  (d) => {
    if (!d || decided) return
    decided = true
    linksFirst.value = !!d.node.category || (d.tree.children.length === 0 && d.backlinks.length > 0)
  },
  { flush: 'sync' },
)

// Arrived from a row's link count: show what links here.
watch(data, async (d) => {
  if (!d || route.query.show !== 'links') return
  await nextTick()
  document.querySelector('.backlinks')?.scrollIntoView({ block: 'start' })
  void router.replace({ query: {} })
})

const node = computed(() => data.value?.node)
const kind = computed<Kind>(() => node.value?.kind ?? 'item')
/** A context (a place, a person, a room…): leads with what links here; its children are notes. */
const isHub = computed(() => !!node.value?.category)
const category = computed(() => categoryById(node.value?.category))
const suggested = computed(() => (isHub.value ? undefined : categoryById(data.value?.suggestedCategory)))
const isRelation = computed(() => kind.value === 'relation')
const isNoRelation = computed(() => props.id === NO_RELATION_ID)
const titleKey = computed(() => `title:${props.id}`)
const titleFocused = computed(() => editing.key === titleKey.value)
const parent = computed(() => data.value?.ancestors.at(-1))

const placeholder = computed(() => (kind.value === 'pad' ? 'Name this pad' : isHub.value ? 'Name' : 'Untitled'))

const backTarget = computed(() => {
  if (parent.value) return { to: `/n/${parent.value.id}`, label: parent.value.label || 'Untitled' }
  if (category.value) return { to: `/c/${category.value.id}`, label: category.value.name }
  if (kind.value === 'relation') return { to: '/relations', label: 'Relations' }
  return { to: '/pads', label: 'Pads' }
})

async function saveTitle(text: string) {
  await api.updateText(props.id, text)
}

function onTitleEnter() {
  outline.value?.addChild('first')
}

function onTitleArrow(dir: 'up' | 'down') {
  if (dir === 'down') outline.value?.focusFirst()
}

/** Vim keys in the title: j goes down into the list, o opens its first line. */
function onTitleVim(a: VimRowAction) {
  if (a.action === 'down' || a.action === 'first') outline.value?.focusFirst()
  else if (a.action === 'open-below') outline.value?.addChild('first')
  else if (a.action === 'undo') outline.value?.vimUndo()
  else if (a.action === 'open' && a.link) vimOpen(`/n/${a.link}`)
}

function focusTitle() {
  focusEditor(titleKey.value, 'end')
}

/** Focus the title to type a name (a new pad, Rename): with Vim keys, in insert mode. */
function editTitle() {
  vimInsert()
  focusTitle()
}

function titleLink() {
  openLinkPicker(titleKey.value, Number.MAX_SAFE_INTEGER, false, props.id)
}

async function toggleDone() {
  if (!node.value || kind.value !== 'item') return
  await api.setDone(props.id, !node.value.done).catch(reportError)
}

async function toggleTask() {
  if (!node.value || kind.value !== 'item') return
  await api.setTask(props.id, !node.value.task).catch(reportError)
}

/** "[] " / "[x] " / "- " typed at the start of the title. */
async function onTitleMarker(m: LineMarker) {
  if (kind.value !== 'item') return
  try {
    if (m.done) return await api.setDone(props.id, true)
    if (m.task === undefined) return
    await api.setTask(props.id, m.task)
    if (m.task) await api.setDone(props.id, false)
  } catch (e) {
    reportError(e)
  }
}

function onTitleShortcut(name: Shortcut) {
  if (name === 'toggle-done') void toggleDone()
  else if (name === 'toggle-task') void toggleTask()
}

async function toggleBacklink(id: string, done: boolean) {
  await api.setDone(id, done).catch(reportError)
}

async function restore() {
  await api.restoreSubtree(props.id).catch(reportError)
  toast('Restored')
}

async function remove() {
  const d = data.value
  if (!d) return
  const count = countDescendants(d.tree)
  const name = titleLabel.value
  if (count > 0) {
    const ok = await confirmDialog({
      title: `Delete “${name}”?`,
      message: `This also deletes the ${count} ${count === 1 ? 'item' : 'items'} inside it. You can restore it from Trash in Settings.`,
      confirmLabel: 'Delete',
      danger: true,
    })
    if (!ok) return
  }
  try {
    await api.deleteSubtree(props.id)
    const back = backTarget.value.to
    if (prefs.lastPad === props.id) prefs.lastPad = null
    toast(`Deleted “${name}”`, {
      action: {
        label: 'Undo',
        run: () =>
          void api
            .restoreSubtree(props.id)
            .then(() => router.push(`/n/${props.id}`))
            .catch(reportError),
      },
    })
    void router.replace(back)
  } catch (e) {
    reportError(e)
  }
}

const titleLabel = computed(() => {
  const l = labelize(node.value?.text ?? '', (id) => refCache[id]?.label).replace(/\s+/g, ' ').trim()
  return (l.length > 40 ? l.slice(0, 39) + '…' : l) || 'Untitled'
})

function countDescendants(t: TreeNode): number {
  return t.children.reduce((n, c) => n + 1 + countDescendants(c), 0)
}

function moveTo() {
  openPicker({
    mode: 'move',
    title: `Move “${titleLabel.value}” to`,
    placeholder: 'Search, or browse below',
    excludeIds: data.value ? subtreeIds(data.value.tree) : [props.id],
    startNear: props.id,
    onPick: (r) => {
      api
        .moveSubtree(props.id, r.id)
        .then(() => toast(`Moved to “${r.label}”`))
        .catch(reportError)
    },
  })
}

function chooseKind() {
  if (node.value) chooseCategory(props.id, titleLabel.value, node.value.category)
}

function acceptSuggestion() {
  const c = suggested.value
  if (!c) return
  api
    .setCategory(props.id, c.id)
    .then(() => toast(`“${titleLabel.value}” is in ${c.name}`))
    .catch(reportError)
}

/** Page menu for one of your relations: rename, merge, stop using it. */
function openRelationMenu() {
  const name = titleLabel.value
  const actions: SheetAction[] = []
  if (!isNoRelation.value) {
    actions.push(
      {
        label: 'Rename…',
        icon: 'edit',
        run: async () => {
          const next = await promptDialog({ title: `Rename “${name}”`, confirmLabel: 'Rename', value: name })
          if (!next) return
          const id = await api.renameRelation(props.id, next).catch(reportError)
          if (id && id !== props.id) void router.replace(`/n/${id}`)
        },
      },
      {
        label: 'Merge into…',
        icon: 'move',
        run: () =>
          pickRelation(
            `Merge “${name}” into`,
            (r) =>
              void api
                .mergeRelation(props.id, r.id)
                .then(() => {
                  toast(`“${name}” is now “${r.label}”`)
                  void router.replace(`/n/${r.id}`)
                })
                .catch(reportError),
            [props.id],
          ),
      },
    )
  }
  actions.push(
    { label: 'All relations', icon: 'list', run: () => void router.push('/relations') },
    {
      label: isNoRelation.value ? 'Forget all of these' : `Stop using “${name}”`,
      icon: 'trash',
      danger: true,
      run: async () => {
        const ok = await confirmDialog({
          title: isNoRelation.value ? 'Forget these phrases?' : `Stop using “${name}”?`,
          message: 'Links go back to their suggested labels. You can restore it from Trash.',
          confirmLabel: isNoRelation.value ? 'Forget' : 'Stop using it',
          danger: true,
        })
        if (!ok) return
        await api.deleteSubtree(props.id).catch(reportError)
        void router.replace('/relations')
      },
    },
  )
  openSheet({ title: name, actions })
}

function openMenu() {
  if (!node.value) return
  if (isRelation.value) return openRelationMenu()
  const actions: SheetAction[] = [{ label: 'Show graph', icon: 'graph', run: () => router.push(`/n/${props.id}/graph`) }]
  const tree = data.value?.tree
  if (tree) {
    actions.push({
      label: 'Copy as markdown',
      icon: 'copy',
      run: () => copyPage(tree, kind.value === 'pad', titleLabel.value),
    })
  }
  if (kind.value === 'item' || kind.value === 'place' || kind.value === 'person') {
    actions.push(
      { label: 'Move to…', icon: 'move', run: moveTo },
      ...sendActions({ id: props.id, label: titleLabel.value }, data.value ? subtreeIds(data.value.tree) : [props.id]),
      category.value
        ? { label: `Change kind (${category.value.name})…`, icon: category.value.icon, run: chooseKind }
        : { label: 'Give it a kind…', icon: 'grid', run: chooseKind },
    )
  } else {
    actions.push({ label: 'Rename', icon: 'edit', run: editTitle })
  }
  if (kind.value !== 'category') {
    actions.push({ label: 'Add a fact…', icon: 'linked', run: () => addFact({ id: props.id, label: titleLabel.value }) })
  }
  const n = node.value
  if (kind.value === 'item' && !isHub.value) {
    actions.push({
      label: n.task ? 'Remove the checkbox' : 'Add a checkbox',
      icon: n.task ? 'dot' : 'checkbox',
      run: () => void toggleTask(),
    })
  }
  actions.push({
    label: n.numbered ? 'Use bullets for this list' : 'Number this list',
    icon: n.numbered ? 'list' : 'numbered',
    run: () => void api.setNumbered(props.id, !n.numbered).catch(reportError),
  })
  const items = data.value?.tree.children.filter((c) => c.kind === 'item') ?? []
  if (items.length) {
    const all = items.every((c) => c.task)
    actions.push({
      label: all ? 'Remove checkboxes from this list' : 'Add checkboxes to this list',
      icon: all ? 'list' : 'checkbox',
      run: () => outline.value?.setRootChildrenTask(!all),
    })
  }
  actions.push({ label: kind.value === 'pad' ? 'Delete pad' : 'Delete', icon: 'trash', danger: true, run: () => void remove() })
  openSheet({ title: titleLabel.value, actions })
}

function closeKeyboard() {
  ;(document.activeElement as HTMLElement | null)?.blur()
}

// Focus the title when asked (new pad / new place).
onMounted(async () => {
  if (route.query.focus !== 'title') return
  await reload()
  await nextTick()
  editTitle()
  void router.replace({ query: {} })
})
</script>

<template>
  <div class="page node-page">
    <header class="topbar">
      <RouterLink class="back" :to="backTarget.to">
        <Icon name="chevron-left" />
        <span class="back-label">{{ backTarget.label }}</span>
      </RouterLink>
      <span class="spacer" />
      <RouterLink class="icon-btn" :to="`/n/${id}/graph`" aria-label="Show graph"><Icon name="graph" /></RouterLink>
      <button type="button" class="icon-btn" aria-label="More" @click="openMenu"><Icon name="more" /></button>
    </header>

    <p v-if="error && !data" class="empty-state">This item doesn’t exist. It may have been deleted for good.</p>
    <div v-else-if="loading && !data" class="loading" />

    <template v-else-if="data && node">
      <nav v-if="data.ancestors.length > 1" class="crumbs" aria-label="Path">
        <template v-for="(c, i) in data.ancestors" :key="c.id">
          <RouterLink :to="`/n/${c.id}`">{{ c.label || 'Untitled' }}</RouterLink>
          <span v-if="i < data.ancestors.length - 1" class="sep">›</span>
        </template>
      </nav>

      <div v-if="node.deleted" class="banner">
        <span>This was deleted.</span>
        <button type="button" class="btn btn-small" @click="restore"><Icon name="undo" :size="16" /> Restore</button>
      </div>

      <div class="title-block" :class="[`kind-${kind}`, { done: node.done }]">
        <button
          v-if="category"
          type="button"
          class="kind-tag"
          :class="`tone-${category.tone}`"
          :aria-label="`${category.name}: change kind`"
          @click="chooseKind"
        >
          <Icon :name="category.icon" :size="15" />{{ category.name }}
        </button>
        <span v-else-if="kind !== 'item' && kind !== 'place' && kind !== 'person'" class="kind-tag" :class="`kind-${kind}`">
          <KindIcon :kind="kind" :size="15" />{{ KIND_NAMES[kind] }}
        </span>
        <div class="title-row">
          <button
            v-if="kind === 'item' && node.task && !isHub"
            type="button"
            class="check big"
            role="checkbox"
            :aria-checked="node.done"
            aria-label="Done"
            @mousedown.prevent
            @click="toggleDone"
          >
            <span class="box"><Icon v-if="node.done" name="check" :size="18" :stroke="3" /></span>
          </button>
          <h1 v-if="isRelation" class="title static-title">{{ node.text || 'Untitled' }}</h1>
          <EditableText
            v-else
            :key="id"
            class="title"
            :text="node.text"
            :editor-key="titleKey"
            :node-id="id"
            :save="saveTitle"
            :placeholder="placeholder"
            label="Title"
            @enter="onTitleEnter"
            @arrow="onTitleArrow"
            @vim="onTitleVim"
            @at-trigger="(o) => openLinkPicker(titleKey, o, true, id)"
            @paste-lines="(r) => outline?.addLines([...r.inside, ...r.after])"
            @marker="onTitleMarker"
            @shortcut="onTitleShortcut"
            @chip="(cid) => router.push(`/n/${cid}`)"
          />
        </div>
      </div>

      <div v-if="suggested && !node.deleted" class="context-suggestion">
        <span>Looks like one of your {{ suggested.name }}.</span>
        <button type="button" class="btn btn-small" @click="acceptSuggestion">
          <Icon :name="suggested.icon" :size="16" /> Add to {{ suggested.name }}
        </button>
        <button type="button" class="link-btn" @click="chooseKind">Another kind…</button>
      </div>

      <FactsList
        v-if="!isRelation && !node.deleted && (data.facts.length || isHub)"
        :facts="data.facts"
        :subject="{ id, label: titleLabel }"
      />

      <template v-if="isRelation && !node.deleted">
        <RelationLinks
          :links="data.relationLinks"
          :heading="isNoRelation ? 'Links worded like these' : 'Links'"
          @toggle="toggleBacklink"
        />
        <h2 class="section-title">{{ isNoRelation ? 'Wordings you treat as plain mentions' : 'Also written as' }}</h2>
      </template>

      <Backlinks
        v-if="!isRelation && linksFirst && (isHub || data.backlinks.length) && !node.deleted"
        :backlinks="data.backlinks"
        :target="id"
        heading="Linked here"
        @toggle="toggleBacklink"
      />

      <h2 v-if="linksFirst && data.tree.children.length" class="section-title">{{ isHub ? 'Notes' : 'Inside' }}</h2>
      <Outline
        v-if="!node.deleted"
        ref="outline"
        :root="data.tree"
        :reload="reload"
        :add-label="isRelation ? 'wording' : isHub ? 'note' : 'item'"
        @exit-top="focusTitle"
      />

      <section v-if="data.outgoing.length" class="links-out">
        <h2 class="section-title">Links</h2>
        <div class="chip-row">
          <RouterLink v-for="r in data.outgoing" :key="r.id" :to="`/n/${r.id}`" :class="chipClass(r)">{{
            chipLabel(r)
          }}</RouterLink>
        </div>
      </section>

      <Backlinks
        v-if="!isRelation && !linksFirst && data.backlinks.length && !node.deleted"
        :backlinks="data.backlinks"
        :target="id"
        heading="Linked here"
        @toggle="toggleBacklink"
      />
    </template>

    <Teleport to="body">
      <EditToolbar
        v-if="titleFocused && !pickerState"
        :structure="false"
        :task="kind === 'item' ? (node?.task ?? false) : null"
        @link="titleLink"
        @task="toggleTask"
        @close="closeKeyboard"
      />
    </Teleport>
  </div>
</template>
