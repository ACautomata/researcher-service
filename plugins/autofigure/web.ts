// AutoFigure 插件 web 面入口（#799 · #752 §2.4 R14 形态）：工具名 → 自定义渲染组件
// 注册表。FigureCard 是归约产物 custom-render 分支（#730 单管线），未注册工具走默认
// 工具行渲染（零成本回退）。
//
// 收录 = frontend/src/plugins/index.ts 显式 import 本文件一行（#752 R1 两处收录行的
// 前端侧）。本文件归 frontend 面类型检查（server tsconfig exclude web.ts——web 面拉
// vue 依赖进 server typecheck 是错误方向）。
//
// 铁律（#791 对称面）：本文件在 plugins/ 树内，禁裸包名 import——definePluginWeb 经
// 前端契约模块相对直引（type-only，编译期擦除）；FigureCard 的 vue 运行时依赖在其内部
// 经 @/plugins/deps 桥。web.ts 不 import server.ts（避免把 node 依赖拉进前端 bundle），
// 工具名字面量与 plugins/autofigure/server.ts FIGURE_TOOL_NAME 单源注释锁定。
import { definePluginWeb } from '../../frontend/src/plugins/api'
import FigureCard from './components/FigureCard.vue'

export default definePluginWeb({
  components: {
    // key = 插件工具名（= plugins/autofigure/server.ts 导出的 FIGURE_TOOL_NAME）
    figure_generate: FigureCard,
  },
})
