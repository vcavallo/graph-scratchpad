import { createApp } from 'vue'
import '@fontsource-variable/atkinson-hyperlegible-next/wght.css'
import './styles/main.css'
import App from './App.vue'
import { router } from './router'
import { startDb } from './db/api'
import { persistOnFirstRun } from './lib/storage'
import { trackKeyboard } from './lib/viewport'
import { startSyncTriggers } from './state/sync'

startDb()
startSyncTriggers()
trackKeyboard()
void persistOnFirstRun()

createApp(App).use(router).mount('#app')
