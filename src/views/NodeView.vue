<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import EditableText from '@/components/EditableText.vue'
import Outline from '@/components/Outline.vue'
import Backlinks from '@/components/Backlinks.vue'
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
import { chipClass, chipLabel } from '@/lib/editorDom'
import { confirmDialog, openPicker, openSheet, pickerState, reportError, toast, type SheetAction } from '@/state/ui'

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

const node = computed(() => data.value?.node)
const kind = computed<Kind>(() => node.value?.kind ?? 'item')
const isHub = computed(() => kind.value === 'place' || kind.value === 'person')
const titleKey = computed(() => `title:${props.id}`)
const titleFocused = computed(() => editing.key === titleKey.value)
const parent = computed(() => data.value?.ancestors.at(-1))

const placeholder = computed(() =>
  kind.value === 'pad' ? 'Name this pad' : kind.value === 'place' ? 'Name this place' : kind.value === 'person' ? 'Name' : 'Untitled',
)

const backTarget = computed(() => {
  if (parent.value) return { to: `/n/${parent.value.id}`, label: parent.value.label || 'Untitled' }
  if (kind.value === 'place') return { to: '/places', label: 'Places' }
  if (kind.value === 'person') return { to: '/people', label: 'People' }
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

function focusTitle() {
  focusEditor(titleKey.value, 'end')
}

function titleLink() {
  openLinkPicker(titleKey.value, Number.MAX_SAFE_INTEGER, false, props.id)
}

async function toggleDone() {
  if (!node.value) return
  await api.setDone(props.id, !node.value.done).catch(reportError)
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

async function convertToHub(k: 'place' | 'person') {
  try {
    const hub = await api.convertToHub(props.id, k)
    if (hub !== props.id) {
      toast(`“${titleLabel.value}” is now a ${k}; the line links to it`)
      void router.push(`/n/${hub}`)
    }
  } catch (e) {
    reportError(e)
  }
}

function openMenu() {
  if (!node.value) return
  const actions: SheetAction[] = [{ label: 'Show graph', icon: 'graph', run: () => router.push(`/n/${props.id}/graph`) }]
  if (kind.value === 'item') {
    actions.push(
      { label: 'Move to…', icon: 'move', run: moveTo },
      { label: 'Turn into a place', icon: 'pin', run: () => void convertToHub('place') },
      { label: 'Turn into a person', icon: 'person', run: () => void convertToHub('person') },
    )
  } else if (kind.value === 'place' || kind.value === 'person') {
    const other = kind.value === 'place' ? 'person' : 'place'
    actions.push({
      label: `Make it a ${other}`,
      icon: other === 'place' ? 'pin' : 'person',
      run: () => void api.setKind(props.id, other).catch(reportError),
    })
    if (parent.value) {
      // Lives inside a list (made by an older version): let it be a plain item again.
      actions.push({ label: 'Make it a plain item', icon: 'dot', run: () => void api.setKind(props.id, 'item').catch(reportError) })
    }
  } else {
    actions.push({ label: 'Rename', icon: 'edit', run: focusTitle })
  }
  const n = node.value
  actions.push({
    label: n.numbered ? 'Use bullets for this list' : 'Number this list',
    icon: n.numbered ? 'list' : 'numbered',
    run: () => void api.setNumbered(props.id, !n.numbered).catch(reportError),
  })
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
  focusTitle()
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
        <span v-if="kind !== 'item'" class="kind-tag" :class="`kind-${kind}`">
          <KindIcon :kind="kind" :size="15" />{{ KIND_NAMES[kind] }}
        </span>
        <div class="title-row">
          <button
            v-if="kind === 'item'"
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
          <EditableText
            :key="id"
            class="title"
            :text="node.text"
            :editor-key="titleKey"
            :save="saveTitle"
            :placeholder="placeholder"
            label="Title"
            @enter="onTitleEnter"
            @arrow="onTitleArrow"
            @at-trigger="(o) => openLinkPicker(titleKey, o, true, id)"
            @paste-lines="(lines) => outline?.addLines(lines)"
            @chip="(cid) => router.push(`/n/${cid}`)"
          />
        </div>
      </div>

      <Backlinks
        v-if="isHub && !node.deleted"
        :backlinks="data.backlinks"
        heading="Linked from"
        @toggle="toggleBacklink"
      />

      <h2 v-if="isHub && data.tree.children.length" class="section-title">Notes</h2>
      <Outline
        v-if="!node.deleted"
        ref="outline"
        :root="data.tree"
        :reload="reload"
        :add-label="isHub ? 'note' : 'item'"
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
        v-if="!isHub && data.backlinks.length && !node.deleted"
        :backlinks="data.backlinks"
        heading="Linked from"
        @toggle="toggleBacklink"
      />
    </template>

    <Teleport to="body">
      <EditToolbar v-if="titleFocused && !pickerState" :structure="false" @link="titleLink" @close="closeKeyboard" />
    </Teleport>
  </div>
</template>
