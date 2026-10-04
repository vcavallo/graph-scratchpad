<script setup lang="ts">
import { computed, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useRegisterSW } from 'virtual:pwa-register/vue'
import BottomNav from './components/BottomNav.vue'
import NodePicker from './components/NodePicker.vue'
import ActionSheet from './components/ActionSheet.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'
import Toasts from './components/Toasts.vue'
import { dbState, syncState } from './db/api'
import { editing } from './state/focus'
import { closePicker, closeSheet, confirmState, pickerState, toast } from './state/ui'

const { needRefresh, updateServiceWorker } = useRegisterSW({
  immediate: true,
  onOfflineReady() {
    toast('Ready to work offline')
  },
  onRegisteredSW(_url, reg) {
    if (reg) setInterval(() => void reg.update(), 30 * 60 * 1000)
  },
})

function applyUpdate() {
  void updateServiceWorker(true)
  // If the new worker never takes control (e.g. the page wasn't controlled), reload anyway.
  setTimeout(() => window.location.reload(), 3000)
}

const chromeHidden = computed(() => !!editing.key || !!pickerState.value)

// The first time this device finds the site's sync server, say so once.
watch(
  () => syncState.autoEnabled,
  (on) => {
    if (on) toast(`Syncing with ${syncState.server || 'this server'}. Your lists are kept there too.`, { ms: 6000 })
  },
)

// Android's back button navigates; don't leave an overlay over the next page.
const route = useRoute()
watch(
  () => route.path,
  () => {
    closePicker()
    closeSheet()
    confirmState.value?.resolve(false)
  },
)
</script>

<template>
  <div class="app" :class="{ editing: chromeHidden }">
    <div v-if="dbState.storage === 'memory'" class="banner banner-danger" role="alert">
      Not saving: on-device storage is unavailable here, so changes vanish when you close this tab.
    </div>
    <div v-if="needRefresh" class="banner banner-update">
      <span>A new version is ready.</span>
      <button type="button" class="btn btn-small btn-primary" @click="applyUpdate">Reload</button>
    </div>

    <main class="main">
      <div v-if="dbState.status === 'waiting'" class="empty-state">
        Scratchpad is open in another tab or window. Close it there and this one will pick up.
      </div>
      <div v-else-if="dbState.status === 'fatal'" class="empty-state error">
        The database couldn’t start: {{ dbState.error }}
      </div>
      <RouterView v-else v-slot="{ Component, route }">
        <component :is="Component" :key="route.path" />
      </RouterView>
    </main>

    <BottomNav v-show="!chromeHidden" />
    <NodePicker />
    <ActionSheet />
    <ConfirmDialog />
    <Toasts />
  </div>
</template>
