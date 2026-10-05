<script setup lang="ts">
// Your vocabulary of relations: the ones you kept (with the other ways you
// write them), suggestions from how your lines are worded, and the phrases
// you said aren't relations.
import Icon from '@/components/Icon.vue'
import { api } from '@/db/api'
import { useLoader } from '@/composables/useLoader'
import { openLabelSheet } from '@/lib/relationActions'
import { NO_RELATION_ID } from '@/db/types'

const { data, loading } = useLoader(() => api.listRelations())
</script>

<template>
  <div class="page relations-page">
    <header class="topbar">
      <RouterLink class="back" to="/settings"><Icon name="chevron-left" /><span class="back-label">Settings</span></RouterLink>
    </header>
    <h1 class="page-title standalone">Relations</h1>
    <p class="note">
      What your links mean, read from how you write them: “buy elbows at <em>Hardware store</em>” is <em>buy at</em>.
      Keep the ones you use, and fold other wordings into them.
    </p>
    <div v-if="loading && !data" class="loading" />
    <template v-else-if="data">
      <h2 class="section-title">Yours <span class="count">{{ data.relations.length }}</span></h2>
      <p v-if="!data.relations.length" class="empty-note">None yet. Keep a suggestion below to start.</p>
      <ul class="list">
        <li v-for="r in data.relations" :key="r.id" class="list-item">
          <RouterLink :to="`/n/${r.id}`" class="list-main">
            <span class="list-text">
              <span class="list-label">{{ r.name }}</span>
              <span v-if="r.aliases.length" class="list-context">also {{ r.aliases.map((a) => a.text).join(', ') }}</span>
            </span>
            <span class="list-meta">{{ r.count }} {{ r.count === 1 ? 'link' : 'links' }}</span>
          </RouterLink>
        </li>
      </ul>

      <h2 class="section-title">Suggested <span class="count">{{ data.suggestions.length }}</span></h2>
      <p v-if="!data.suggestions.length" class="empty-note">Nothing waiting. New wordings show up here as you link things.</p>
      <ul class="list">
        <li v-for="s in data.suggestions" :key="s.phrase" class="list-item">
          <button
            type="button"
            class="list-main"
            @click="openLabelSheet({ label: s.phrase, suggested: s.phrase, relationId: null })"
          >
            <span class="list-text"><span class="list-label suggested-label">{{ s.phrase }}</span></span>
            <span class="list-meta">{{ s.count }} {{ s.count === 1 ? 'link' : 'links' }}</span>
          </button>
        </li>
      </ul>

      <template v-if="data.ignored.length">
        <h2 class="section-title">Not relations</h2>
        <ul class="list">
          <li v-for="i in data.ignored" :key="i.id" class="list-item">
            <button
              type="button"
              class="list-main"
              @click="openLabelSheet({ label: null, suggested: i.text, relationId: NO_RELATION_ID })"
            >
              <span class="list-text"><span class="list-label muted-label">{{ i.text }}</span></span>
            </button>
          </li>
        </ul>
      </template>
    </template>
  </div>
</template>
