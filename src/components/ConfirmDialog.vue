<script setup lang="ts">
import { confirmState } from '@/state/ui'
</script>

<template>
  <Teleport to="body">
    <div v-if="confirmState" class="sheet-backdrop center" @click.self="confirmState.resolve(false)">
      <div class="dialog" role="alertdialog" :aria-label="confirmState.title">
        <h2 class="dialog-title">{{ confirmState.title }}</h2>
        <p v-if="confirmState.message" class="dialog-msg">{{ confirmState.message }}</p>
        <div class="dialog-actions">
          <button type="button" class="btn" @click="confirmState.resolve(false)">Cancel</button>
          <button
            type="button"
            class="btn"
            :class="confirmState.danger ? 'btn-danger' : 'btn-primary'"
            @click="confirmState.resolve(true)"
          >
            {{ confirmState.confirmLabel }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
