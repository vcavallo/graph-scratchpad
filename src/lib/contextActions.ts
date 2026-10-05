// Choosing what kind of context something is (or making a new kind), and the
// settings of a kind: its tab in the bar, its icon, its name.

import { api } from '@/db/api'
import { router } from '@/router'
import { CATEGORY_ICONS, MAX_PINNED, categories, categoryById } from '@/state/categories'
import { confirmDialog, openSheet, promptDialog, reportError, toast, type SheetAction } from '@/state/ui'

/** Ask for a new kind's name and make it. Resolves to its id, or null. */
export async function newCategory(): Promise<string | null> {
  const name = await promptDialog({
    title: 'New kind of context',
    message: 'Rooms, Projects, Stores… Anything you link to that’s worth a list of its own.',
    confirmLabel: 'Make it',
    placeholder: 'Rooms',
  })
  if (!name) return null
  return api.createCategory(name).catch((e) => {
    reportError(e)
    return null
  })
}

/**
 * What kind of context is this? Sets it where the node is (it stays in its
 * list). Also offers a new kind, and "not a context".
 */
export function chooseCategory(nodeId: string, label: string, current: string | null): void {
  const set = (catId: string | null, name?: string) =>
    void api
      .setCategory(nodeId, catId)
      .then(() => toast(catId ? `“${label}” is in ${name}` : `“${label}” isn’t a context now`))
      .catch(reportError)
  const actions: SheetAction[] = categories.value.map((c) => ({
    label: c.id === current ? `${c.name} ✓` : c.name,
    icon: c.icon,
    run: () => set(c.id, c.name),
  }))
  actions.push({
    label: 'New kind…',
    icon: 'plus',
    run: async () => {
      const id = await newCategory()
      if (id) set(id, categoryById(id)?.name ?? 'it')
    },
  })
  if (current) actions.push({ label: 'Not a context', icon: 'x', run: () => set(null) })
  openSheet({ title: `What is “${label}”?`, actions })
}

export function togglePinned(id: string): void {
  const c = categoryById(id)
  if (!c) return
  if (!c.pinned && categories.value.filter((x) => x.pinned).length >= MAX_PINNED) {
    toast(`Up to ${MAX_PINNED} kinds fit in the bar. Take one out first.`, { ms: 4000 })
    return
  }
  api
    .setCategoryProps(id, { pinned: !c.pinned })
    .then(() => toast(c.pinned ? `${c.name} is under Contexts now` : `${c.name} has a tab now`))
    .catch(reportError)
}

/** The ⋯ menu of a kind's page. */
export function openCategoryMenu(id: string): void {
  const c = categoryById(id)
  if (!c) return
  openSheet({
    title: c.name,
    actions: [
      { label: c.pinned ? 'Take it out of the bar' : 'Give it a tab in the bar', icon: 'pin', run: () => togglePinned(id) },
      {
        label: 'Change icon…',
        icon: c.icon,
        run: () =>
          openSheet({
            title: `Icon for ${c.name}`,
            actions: CATEGORY_ICONS.map((icon) => ({
              label: icon === c.icon ? `${icon} ✓` : icon,
              icon,
              run: () => void api.setCategoryProps(id, { icon }).catch(reportError),
            })),
          }),
      },
      {
        label: 'Rename…',
        icon: 'edit',
        run: async () => {
          const name = await promptDialog({ title: `Rename ${c.name}`, confirmLabel: 'Rename', value: c.name })
          if (name) api.updateText(id, name).catch(reportError)
        },
      },
      {
        label: `Delete ${c.name}`,
        icon: 'trash',
        danger: true,
        run: async () => {
          const ok = await confirmDialog({
            title: `Delete ${c.name}?`,
            message: `The ${c.count} ${c.count === 1 ? 'context' : 'contexts'} in it stay where they are, with everything that links to them; they just won’t have a kind. You can restore it from Trash.`,
            confirmLabel: 'Delete',
            danger: true,
          })
          if (!ok) return
          await api.deleteSubtree(id).catch(reportError)
          void router.replace('/contexts')
        },
      },
    ],
  })
}
