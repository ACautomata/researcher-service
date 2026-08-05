import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
// #401：highlight.js 亮色主题全局引入一次（renderMarkdown 高亮 token 着色；代码块底色由
// MarkdownRenderer scoped 样式覆盖，不引 github-markdown-css 全量）
import 'highlight.js/styles/atom-one-light.css'
import './style.css'
import App from './App.vue'
import router from './router'

const app = createApp(App)
const pinia = createPinia()
app.use(pinia)
app.use(router)
app.use(ElementPlus)
app.mount('#app')
