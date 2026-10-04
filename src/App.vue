<script setup lang="ts">
import { computed } from 'vue'
import { useRegisterSW } from 'virtual:pwa-register/vue'
import BottomNav from './components/BottomNav.vue'
import NodePicker from './components/NodePicker.vue'
import ActionSheet from './components/ActionSheet.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'
import Toasts from './components/Toasts.vue'
import { dbState } from './db/api'
import { editing } from './state/focus'
import { pickerState, toast } from './state/ui'

const { needRefresh, updateServiceWorker } = useRegisterSW({
  immediate: true,
  onOfflineReady() {
    toast('Ready to work offline')
  },
  onRegisteredSW(_url, reg) {
    if (reg) setInterval(() => void reg.update(), 30 * 60 * 1000)
  },
})

const chromeHidden = computed(() => !!editing.key || !!pickerState.value)
</script>

<template>
  <div class="app" :class="{ editing: chromeHidden }">
    <div v-if="dbState.storage === 'memory'" class="banner banner-danger" role="alert">
      Not saving: on-device storage is unavailable here, so changes vanish when you close this tab.
    </div>
    <div v-if="needRefresh" class="banner banner-update">
      <span>A new version is ready.</span>
      <button type="button" class="btn btn-small btn-primary" @click="updateServiceWorker(true)">Reload</button>
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
