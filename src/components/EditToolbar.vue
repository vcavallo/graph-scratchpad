<script setup lang="ts">
// The bar that sits on top of the soft keyboard while a line is being edited.
// Buttons swallow mousedown so the editor keeps focus (and the keyboard stays up).
import Icon from './Icon.vue'

withDefaults(
  defineProps<{
    canIndent?: boolean
    canOutdent?: boolean
    canUp?: boolean
    canDown?: boolean
    structure?: boolean
    /** Whether the line is a to-do; null hides the checkbox button (not an item). */
    task?: boolean | null
  }>(),
  { canIndent: true, canOutdent: true, canUp: true, canDown: true, structure: true, task: null },
)
const emit = defineEmits<{
  outdent: []
  indent: []
  up: []
  down: []
  link: []
  task: []
  more: []
  close: []
}>()
</script>

<template>
  <div class="edit-toolbar" role="toolbar" aria-label="Editing tools" @mousedown.prevent>
    <template v-if="structure">
      <button type="button" :disabled="!canOutdent" aria-label="Outdent" @click="emit('outdent')">
        <Icon name="outdent" />
      </button>
      <button type="button" :disabled="!canIndent" aria-label="Indent" @click="emit('indent')">
        <Icon name="indent" />
      </button>
      <button type="button" :disabled="!canUp" aria-label="Move up" @click="emit('up')">
        <Icon name="arrow-up" />
      </button>
      <button type="button" :disabled="!canDown" aria-label="Move down" @click="emit('down')">
        <Icon name="arrow-down" />
      </button>
    </template>
    <button type="button" aria-label="Insert link" @click="emit('link')"><Icon name="at" /></button>
    <button
      v-if="task !== null"
      type="button"
      class="toggle"
      aria-label="Checkbox"
      :aria-pressed="task"
      @click="emit('task')"
    >
      <Icon name="checkbox" />
    </button>
    <button v-if="structure" type="button" aria-label="More actions" @click="emit('more')">
      <Icon name="more" />
    </button>
    <span class="spacer" />
    <button type="button" aria-label="Hide keyboard" @click="emit('close')"><Icon name="keyboard-hide" /></button>
  </div>
</template>
