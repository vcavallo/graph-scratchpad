<script setup lang="ts">
// Entry point: reopen the last pad, or the first one, or seed a welcome pad.
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '@/db/api'
import { prefs } from '@/state/prefs'
import { reportError } from '@/state/ui'

const router = useRouter()

onMounted(async () => {
  try {
    const last = prefs.lastPad
    if (last) {
      const n = await api.getNode(last)
      if (n && !n.deleted) return void router.replace(`/n/${last}`)
    }
    // A new device on a site with sync: get the lists first, rather than showing the welcome pad.
    await api.syncReady().catch(() => {})
    const seeded = await api.seedIfEmpty()
    if (seeded) return void router.replace(`/n/${seeded}`)
    const pads = await api.listPads()
    void router.replace(pads.length ? `/n/${pads[0].id}` : '/pads')
  } catch (e) {
    reportError(e)
    void router.replace('/pads')
  }
})
</script>

<template>
  <div class="loading" />
</template>
