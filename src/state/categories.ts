// Your kinds of context (Places, People, Rooms…), kept fresh for the nav bar,
// chips, icons and pickers. Reloads whenever the database changes.

import { computed, ref, watch } from 'vue'
import { api, dbState } from '@/db/api'
import type { CategoryInfo } from '@/db/types'

/** How many kinds fit in the bottom bar next to Pads, Contexts, Search and Settings. */
export const MAX_PINNED = 3

/** Icons a kind can have. */
export const CATEGORY_ICONS = ['pin', 'person', 'home', 'folder', 'tag', 'box', 'star', 'calendar']

export const categories = ref<CategoryInfo[]>([])
let loaded = false

async function load() {
  try {
    categories.value = await api.listCategories()
    loaded = true
  } catch {
    // The database isn't ready yet; the next change will try again.
  }
}

export function startCategories(): void {
  watch(
    () => [dbState.status, dbState.version],
    () => {
      if (dbState.status === 'ready') void load()
    },
    { immediate: true },
  )
}

export const pinnedCategories = computed(() => categories.value.filter((c) => c.pinned).slice(0, MAX_PINNED))

export function categoryById(id: string | null | undefined): CategoryInfo | undefined {
  return id ? categories.value.find((c) => c.id === id) : undefined
}

export const categoriesLoaded = () => loaded
