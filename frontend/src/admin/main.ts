// admin 子应用组合根（#800 双面板 MPA）：与主面板 main.ts 同构——共享 style/theme/
// ElementPlus/@/api/@/stores（Pinia store 定义共享，各应用实例独立 pinia），仅壳组件与
// 路由表换为 admin 自己的（产物级隔离：主 bundle 不含 admin 代码，Rollup 多入口对共享
// 依赖产出共享 chunk，无双份基建）。
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import 'highlight.js/styles/atom-one-light.css'
import '@/style.css'
import AdminApp from '@/admin/AdminApp.vue'
import adminRouter from '@/admin/router'
import { installSystemTheme } from '@/theme'

installSystemTheme()
const app = createApp(AdminApp)
const pinia = createPinia()
app.use(pinia)
app.use(adminRouter)
app.use(ElementPlus)
app.mount('#app')
