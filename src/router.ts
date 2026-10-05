import { createRouter, createWebHashHistory } from 'vue-router'
import StartView from './views/StartView.vue'
import NodeView from './views/NodeView.vue'
import PadsView from './views/PadsView.vue'
import { PEOPLE_ID, PLACES_ID } from './db/types'

// Hash history: the app is served as static files with no server-side routing.
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', component: StartView },
    { path: '/pads', component: PadsView },
    { path: '/n/:id', component: NodeView, props: true },
    { path: '/n/:id/graph', component: () => import('./views/GraphView.vue'), props: true },
    { path: '/c/:id', component: () => import('./views/CategoryView.vue'), props: true },
    { path: '/contexts', component: () => import('./views/ContextsView.vue') },
    // Older links to the two built-in kinds.
    { path: '/places', redirect: `/c/${PLACES_ID}` },
    { path: '/people', redirect: `/c/${PEOPLE_ID}` },
    { path: '/search', component: () => import('./views/SearchView.vue') },
    { path: '/settings', component: () => import('./views/SettingsView.vue') },
    { path: '/trash', component: () => import('./views/TrashView.vue') },
    { path: '/relations', component: () => import('./views/RelationsView.vue') },
    { path: '/:rest(.*)*', redirect: '/' },
  ],
  scrollBehavior(_to, _from, saved) {
    return saved ?? { top: 0 }
  },
})
