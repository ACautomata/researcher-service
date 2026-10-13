// research 插件 web 面（#913 · 853 §6.2）：工具名 → 自定义组件注册表。
// key = plugins/research/server.ts 导出的 RESEARCH_TOOL_NAME（'research_workflow'）——
// web.ts 禁 import server.ts（会拖 LangGraph 进前端 bundle），字面量与 server 常量
// 注释单源锁定（autofigure web.ts 先例）。
import { definePluginWeb } from '../../frontend/src/plugins/api'
import ResearchRunCard from './components/ResearchRunCard.vue'

export default definePluginWeb({
  components: {
    research_workflow: ResearchRunCard,
  },
})
