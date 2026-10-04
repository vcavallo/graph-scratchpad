import { onScopeDispose, ref, shallowRef, watch } from 'vue'
import { dbState } from '@/db/api'

/**
 * Load data from the worker and keep it fresh: reloads after every write
 * that changed rows. A result is never applied if a write was sent while it
 * was in flight (it could predate optimistic UI state); the load is retried,
 * waiting for outstanding writes to be answered once retries pile up.
 */
export function useLoader<T>(fetch: () => Promise<T>) {
  const data = shallowRef<T | null>(null)
  const error = ref<unknown>(null)
  const loading = ref(true)
  let inflight: Promise<void> | null = null
  let queued: Promise<void> | null = null
  let disposed = false

  const writesSettled = () =>
    new Promise<void>((resolve) => {
      if (dbState.writesPending === 0) return resolve()
      const stop = watch(
        () => dbState.writesPending,
        (n) => {
          if (n === 0) {
            stop()
            resolve()
          }
        },
      )
    })

  async function run(): Promise<void> {
    for (let attempt = 0; !disposed; attempt++) {
      if (attempt >= 3) await writesSettled()
      const writes = dbState.writesSent
      try {
        const d = await fetch()
        if (disposed) return
        if (dbState.writesSent !== writes) continue
        data.value = d
        error.value = null
      } catch (e) {
        error.value = e
      }
      loading.value = false
      return
    }
  }

  function reload(): Promise<void> {
    if (!inflight) {
      inflight = run().finally(() => {
        inflight = null
      })
      return inflight
    }
    queued ??= inflight.then(() => {
      queued = null
      return reload()
    })
    return queued
  }

  watch(
    () => dbState.version,
    () => void reload(),
  )
  onScopeDispose(() => {
    disposed = true
  })
  void reload()
  return { data, error, loading, reload }
}
