import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import './style.css'
import App from './App.vue'
import router from './router'
import { apiFetch } from '@/api/client'
import { listInstances } from '@/api/containers'
import { getTree } from '@/api/wiki'

const app = createApp(App)
const pinia = createPinia()
app.use(pinia)
app.use(router)
app.use(ElementPlus)
app.mount('#app')

// Dev-only testing hooks for E2E integration tests (#180/#181/#182):
// Playwright-driven backend conftest accesses Pinia state, apiFetch, listInstances and getTree to
// verify 401→refresh→retry, logout redirect, containers-list degradation and wiki-tree read flows
// through real httpOnly cookies and the Vite proxy → live Django chain.
if (import.meta.env.DEV) {
  ;(window as any).__pinia = pinia
  ;(window as any).__apiFetch = apiFetch
  ;(window as any).__listInstances = listInstances
  ;(window as any).__getTree = getTree
}
