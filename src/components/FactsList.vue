<script setup lang="ts">
// The facts you've stated about a node: "cofounder of  Acme".
import Icon from './Icon.vue'
import type { FactView } from '@/db/types'
import { chipClass, chipLabel } from '@/lib/editorDom'
import { addFact, openFactSheet } from '@/lib/factActions'

defineProps<{ facts: FactView[]; subject: { id: string; label: string } }>()
</script>

<template>
  <section class="facts-section">
    <h2 class="section-title">Facts</h2>
    <ul v-if="facts.length" class="fact-list">
      <li v-for="f in facts" :key="f.index" class="fact">
        <span class="fact-rel">{{ f.name }}</span>
        <RouterLink :to="`/n/${f.target.id}`" :class="chipClass(f.target)">{{ chipLabel(f.target) }}</RouterLink>
        <span class="spacer" />
        <button type="button" class="icon-btn" :aria-label="`Options for ${f.name} ${f.target.label}`" @click="openFactSheet(subject, f)">
          <Icon name="more" />
        </button>
      </li>
    </ul>
    <button type="button" class="add-row" @click="addFact(subject)">
      <Icon name="plus" :size="18" /><span>Add a fact</span>
    </button>
  </section>
</template>
