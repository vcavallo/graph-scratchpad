// App-wide overlays: toasts, action sheets, confirm dialogs, and the node picker.

import { reactive, shallowRef } from 'vue'
import type { Kind } from '@/db/types'

export interface Toast {
  id: number
  message: string
  action?: { label: string; run: () => void }
  tone?: 'error'
}

export const toasts = reactive<Toast[]>([])
let toastSeq = 0

export function toast(message: string, opts: { action?: Toast['action']; tone?: Toast['tone']; ms?: number } = {}): void {
  const t: Toast = { id: ++toastSeq, message, action: opts.action, tone: opts.tone }
  toasts.push(t)
  while (toasts.length > 3) toasts.shift()
  setTimeout(() => dismissToast(t.id), opts.ms ?? (opts.action ? 6000 : 3000))
}

export function dismissToast(id: number): void {
  const i = toasts.findIndex((t) => t.id === id)
  if (i >= 0) toasts.splice(i, 1)
}

export function reportError(e: unknown): void {
  console.error(e)
  const msg = e instanceof Error ? e.message : String(e)
  toast(msg, { tone: 'error', ms: 6000 })
}

export interface SheetAction {
  label: string
  icon?: string
  danger?: boolean
  run: () => void
}

export const sheetState = shallowRef<{ title?: string; actions: SheetAction[] } | null>(null)

export function openSheet(s: { title?: string; actions: SheetAction[] }): void {
  sheetState.value = s
}

export function closeSheet(): void {
  sheetState.value = null
}

export interface ConfirmRequest {
  title: string
  message?: string
  confirmLabel: string
  danger?: boolean
  resolve: (ok: boolean) => void
}

export const confirmState = shallowRef<ConfirmRequest | null>(null)

export function confirmDialog(opts: Omit<ConfirmRequest, 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => {
    confirmState.value = {
      ...opts,
      resolve: (ok) => {
        confirmState.value = null
        resolve(ok)
      },
    }
  })
}

export interface PickResult {
  id: string
  kind: Kind
  label: string
}

export interface PickerRequest {
  mode: 'link' | 'move'
  title: string
  placeholder?: string
  excludeIds?: string[]
  /** Kinds to suggest when the query is empty. */
  emptyKinds?: Kind[]
  /** Move mode: start browsing among this node's siblings. */
  startNear?: string
  allowCreate?: boolean
  onPick: (r: PickResult) => void
  onCancel?: () => void
}

export const pickerState = shallowRef<PickerRequest | null>(null)

export function openPicker(req: PickerRequest): void {
  pickerState.value = req
}

export function closePicker(): void {
  pickerState.value = null
}
