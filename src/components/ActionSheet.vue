<script setup lang="ts">
import Icon from './Icon.vue'
import { closeSheet, sheetState, type SheetAction } from '@/state/ui'

function run(a: SheetAction) {
  closeSheet()
  a.run()
}
</script>

<template>
  <Teleport to="body">
    <div v-if="sheetState" class="sheet-backdrop" @mousedown.prevent @click.self="closeSheet">
      <div class="sheet" role="menu" @mousedown.prevent>
        <div v-if="sheetState.title" class="sheet-title">{{ sheetState.title }}</div>
        <button
          v-for="a in sheetState.actions"
          :key="a.label"
          type="button"
          class="sheet-action"
          :class="{ danger: a.danger }"
          role="menuitem"
          @click="run(a)"
        >
          <Icon v-if="a.icon" :name="a.icon" :size="20" />
          <span>{{ a.label }}</span>
        </button>
        <button type="button" class="sheet-action cancel" @click="closeSheet">Cancel</button>
      </div>
    </div>
  </Teleport>
</template>
