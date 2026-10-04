<script setup lang="ts">
import { dismissToast, toasts, type Toast } from '@/state/ui'

function act(t: Toast) {
  dismissToast(t.id)
  t.action?.run()
}
</script>

<template>
  <Teleport to="body">
    <div class="toasts" aria-live="polite">
      <div v-for="t in toasts" :key="t.id" class="toast" :class="t.tone" @mousedown.prevent>
        <span class="toast-msg">{{ t.message }}</span>
        <button v-if="t.action" type="button" class="toast-action" @click="act(t)">{{ t.action.label }}</button>
      </div>
    </div>
  </Teleport>
</template>
