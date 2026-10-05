<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { confirmState } from '@/state/ui'

const text = ref('')
const input = ref<HTMLInputElement>()
watch(confirmState, (c) => {
  text.value = c?.input?.value ?? ''
  if (c?.input) void nextTick(() => input.value?.select())
})

const answer = (ok: boolean) => confirmState.value?.resolve(ok, text.value)
</script>

<template>
  <Teleport to="body">
    <div v-if="confirmState" class="sheet-backdrop center" @click.self="answer(false)">
      <div class="dialog" role="alertdialog" :aria-label="confirmState.title">
        <h2 class="dialog-title">{{ confirmState.title }}</h2>
        <p v-if="confirmState.message" class="dialog-msg">{{ confirmState.message }}</p>
        <input
          v-if="confirmState.input"
          ref="input"
          v-model="text"
          class="dialog-input"
          type="text"
          autocapitalize="off"
          :placeholder="confirmState.input.placeholder"
          @keydown.enter.prevent="answer(true)"
          @keydown.escape.prevent="answer(false)"
        />
        <div class="dialog-actions">
          <button type="button" class="btn" @click="answer(false)">Cancel</button>
          <button
            type="button"
            class="btn"
            :class="confirmState.danger ? 'btn-danger' : 'btn-primary'"
            :disabled="!!confirmState.input && !text.trim()"
            @click="answer(true)"
          >
            {{ confirmState.confirmLabel }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
