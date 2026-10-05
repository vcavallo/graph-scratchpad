// Cache of chip data (label, kind, deleted) for link targets, filled from
// every view load. Editors and read-only text render chips from here.

import { reactive, ref } from 'vue'
import type { RefInfo } from '@/db/types'

export const refCache = reactive<Record<string, RefInfo>>({})
export const refsVersion = ref(0)

export function mergeRefs(refs: Record<string, RefInfo>): void {
  let changed = false
  for (const [id, r] of Object.entries(refs)) {
    const old = refCache[id]
    if (
      !old ||
      old.label !== r.label ||
      old.kind !== r.kind ||
      old.deleted !== r.deleted ||
      old.done !== r.done ||
      old.tone !== r.tone ||
      old.exists !== r.exists
    ) {
      refCache[id] = r
      changed = true
    }
  }
  if (changed) refsVersion.value++
}

export function getRef(id: string): RefInfo | undefined {
  return refCache[id]
}
