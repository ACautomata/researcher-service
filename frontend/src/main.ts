import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import './style.css'
import App from './App.vue'
import router from './router'
import { apiFetch } from '@/api/client'
import { listInstances } from '@/api/containers'

const app = createApp(App)
const pinia = createPinia()
app.use(pinia)
app.use(router)
app.use(ElementPlus)
app.mount('#app')

// Dev-only testing hooks for E2E integration tests (#180/#181):
// Playwright-driven backend conftest accesses Pinia state, apiFetch and listInstances to verify
// 401→refresh→retry, logout redirect and containers-list degradation flows through real httpOnly
// cookies and the Vite proxy → live Django chain.
if (import.meta.env.DEV) {
  ;(window as any).__pinia = pinia
  ;(window as any).__apiFetch = apiFetch
  ;(window as any).__listInstances = listInstances
}
