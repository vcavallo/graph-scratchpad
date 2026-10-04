import { createRouter, createWebHashHistory } from 'vue-router'
import StartView from './views/StartView.vue'
import NodeView from './views/NodeView.vue'
import PadsView from './views/PadsView.vue'

// Hash history: the app is served as static files with no server-side routing.
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', component: StartView },
    { path: '/pads', component: PadsView },
    { path: '/n/:id', component: NodeView, props: true },
    { path: '/n/:id/graph', component: () => import('./views/GraphView.vue'), props: true },
    { path: '/places', component: () => import('./views/IndexView.vue'), props: { kind: 'place' } },
    { path: '/people', component: () => import('./views/IndexView.vue'), props: { kind: 'person' } },
    { path: '/search', component: () => import('./views/SearchView.vue') },
    { path: '/settings', component: () => import('./views/SettingsView.vue') },
    { path: '/trash', component: () => import('./views/TrashView.vue') },
    { path: '/:rest(.*)*', redirect: '/' },
  ],
  scrollBehavior(_to, _from, saved) {
    return saved ?? { top: 0 }
  },
})
