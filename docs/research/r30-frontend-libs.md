# R30 — 前端库选型：Markdown 编辑器 + 关系图谱 + WS/流式渲染

> 对应 **issue #30**。
> 面向 stack：Vue 3 + Vite + TypeScript + Pinia + Vue Router + Element Plus（spec 已预锁）。
> 方法：以一手资料为准（各库官方文档 / GitHub），结论处标注依据。检索时间 2026-07。

---

## TL;DR（结论先行）

| 关注点 | 推荐 | 备选 | 一句话理由 |
|---|---|---|---|
| **Typora 式 md 编辑器** | **Milkdown（`@milkdown/kit` + Crepe）** | Vditor（IR 模式） | 构建在 ProseMirror + **Remark/unified** 之上，wikilink/frontmatter 可直接挂现成 Remark 插件，与本项目 obsidian 风格 vault 天然契合；活跃维护（v7.21.3，2026-07） |
| **关系图谱** | **vis-network（`vue-vis-network2` 包装）** | ECharts graph | 官方事件系统含现成 `click`（含 `params.nodes` 数组），点节点直接开 md 零样板；Barnes-Hut 物理 + `hideEdgesOnDrag/Zoom` 可撑千级节点 |
| **WS 客户端** | **原生 `WebSocket` + 轻量自封装 reconnect/heartbeat composable** | `@vueuse/core` 的 `useWebSocket` | 连 Django Channels 只需 JSON 帧 + 指数退避重连；无服务端协议耦合 |
| **流式渲染 + 折叠面板 + md** | **`markdown-it`（增量渲染）+ Element Plus `el-collapse`** | `vue3-markdown-it` 包装 | 流式 token 追加时反复 `md.render(累积文本)` 即可；折叠面板直接用 EP 组件 |

---

## 1. Typora 式实时渲染 Markdown 编辑器

需求：WYSIWYG / 所见即所得（**非左右分屏**），实时渲染质量高，兼容 wiki 内链 `[[...]]` 与 YAML frontmatter，可嵌入 Vue3，TS 类型完整，维护活跃。

### 1.1 候选对比

| 维度 | **Milkdown** | **Vditor** | Tiptap(+md) | CodeMirror 6 富文本 |
|---|---|---|---|---|
| Vue3 支持 | ✅ 官方 `@milkdown/vue` | ✅ 可用（Composition API），但非官方封装 | ✅ 官方 `@tiptap/vue-3` | ⚠️ 需自包装 |
| 实时渲染质量 | ✅ 真正 WYSIWYG（ProseMirror schema 驱动） | ✅ IR「即时渲染」即 Typora 式 | ✅ WYSIWYG，但 markdown 是「导入/导出」层 | ⚠️ 本质是源码 + 行内装饰，非真 WYSIWYG |
| **wikilink `[[...]]`** | ✅ **Remark 生态现成**：`@flowershow/remark-wiki-link` 支持 `[[link\|text]]`、`[[link#heading]]`、`![[embed]]` | ❌ 不支持，需 hack 其渲染器/预处理 | ⚠️ 需自写 ProseMirror mark + 序列化 | ⚠️ 需自写 tokenizer |
| **frontmatter** | ✅ **Remark 生态现成**：`remark-frontmatter` + `micromark-extension-frontmatter` | ✅ **原生**（README 列入语法支持） | ⚠️ 需自处理 | ⚠️ 需自处理 |
| 可嵌入性 | ✅ 组件即编辑器，主题/插件全可配 | ✅ 单例挂载，`new Vditor(el, opts)` | ✅ 高度可定制（headless） | ✅ 极轻 |
| TS 类型 | ✅ 全量 | ✅ TS 实现（84%） | ✅ 全量 | ✅ 全量 |
| 维护活跃度 | ✅ v7.21.3（2026-07-12） | ✅ v3.11.2（2025-09-02，2781 commits） | ✅ 活跃（但 Cloud/AI 商业化重） | ✅ 活跃 |

依据：Milkdown [GitHub](https://github.com/Milkdown/milkdown)（v7.21.3）、[crepe 文档](https://milkdown.dev/docs/api/crepe)；Vditor [GitHub](https://github.com/Vanessa219/vditor)（v3.11.2，README 明确 YAML Front Matter、三模式 wysiwyg/ir/sv、TS 实现）；Tiptap [Vue3 安装](https://tiptap.dev/docs/editor/getting-started/install/vue3)；wikilink Remark 插件见 [flowershow/remark-wiki-link](https://github.com/flowershow/remark-wiki-link)。

### 1.2 决定性论据：wikilink / frontmatter 的「现成度」

本项目 wiki 是 **obsidian 风格 vault**（见 `docs/research/r29-wiki-crud-path.md` §3）：
- 边来自正文 `[[wikilinks]]`，目标可以是**路径 / id / title**，匹配不到生成 **ghost 虚节点**；
- frontmatter 需兼容**双 schema**（插件 `pageType/id/title` + researcher `type/domain/paper.*/evidence_level`）。

这要求编辑器能**把 `[[...]]` 当一等公民解析/渲染**，且能**保留并忽略 frontmatter**（不渲染为正文、不丢失）。

- **Milkdown = ProseMirror + Remark**。Remark 是 unified 生态的 markdown processor，wikilink 与 frontmatter 都有**现成、活跃维护的官方/社区插件**：
  - wikilink：`@flowershow/remark-wiki-link`（支持 `[[Internal link|自定义文字]]`、`[[link#heading]]`、`![[image.png|200x300]]` 等全套 Obsidian 语法）。
  - frontmatter：`remark-frontmatter`（官方 unified 插件）。
  挂法是在 Milkdown 的 remark 配置里注入这些插件，再配一个 ProseMirror mark 把 wikilink 渲染成可点节点。**这是唯一一条「语法层现成」的路径。**
- **Vditor** 虽原生支持 frontmatter、IR 模式体验好，但 wikilink 需绕过其封闭渲染管线（Vditor 用自研 Lute 引擎而非 unified），只能靠预处理把 `[[x]]` 转 `[x](...)` 再渲染——**会改变落盘文本**，与「编辑已有页面、只覆盖内容」的后端契约（r29）冲突，风险高。
- **Tiptap** markdown 只是导入/导出层，wikilink 需自写 ProMirror mark + 序列化规则，工作量与 Milkdown 相当但生态无现成 wikilink 插件。

### 1.3 编辑器最终推荐

**推荐 Milkdown（`@milkdown/kit` + Crepe 编辑器）**，理由：
1. wikilink / frontmatter 走 Remark 插件，**与本项目 obsidian vault 语义一一对应**，无需发明语法转换；
2. Crepe 提供开箱即用的高质量 WYSIWYG（表格、LaTeX、代码块 CodeMirror、slash 菜单、link-tooltip 默认开启），实时渲染质量对标 Typora；
3. 官方 `@milkdown/vue` 集成 + 全量 TS 类型；
4. 插件化架构 → ghost 虚节点、`pageType` 着色等定制可写成自研插件，不污染主线。

**落地要点：**
```ts
// 依赖
// @milkdown/kit @milkdown/vue
// @flowershow/remark-wiki-link remark-frontmatter
import { Crepe } from '@milkdown/kit/crepe'
import '@milkdown/crepe/theme/common/style.css'
import '@milkdown/crepe/theme/frame.css'

const crepe = new Crepe({
  root: el,
  defaultValue: markdown, // 含 frontmatter + [[wikilink]] 原文
  features: {
    [Crepe.Feature.LinkTooltip]: true,
    [Crepe.Feature.Latex]: true,
    [Crepe.Feature.Table]: true,
    [Crepe.Feature.CodeMirror]: true,
    [Crepe.Feature.BlockEdit]: true, // slash 菜单
  },
})
// 在 remark 层注入 remark-frontmatter（保留并忽略 YAML 头）
// 与 @flowershow/remark-wiki-link（[[...]] → 内联节点），
// 再配一个 ProseMirror node/mark 将 wikilink 渲染为 <a class="internal">，
// 点击时 emit 出 target，路由进对应 md（与图谱点击共用同一回调）。
crepe.on((listener) => listener.markdownUpdated((_, md) => emit('update:modelValue', md)))
```
> 注意：wikilink 需一小段自研 Remark→ProseMirror 映射（把 wikiLink 节点映射为内部链接 mark）。这是本选型**唯一需要自写**的部分，约 1 个插件文件；语法解析本身由 `@flowershow/remark-wiki-link` 完成，**不需自写 tokenizer**。

**若团队想进一步省事、可接受「无 wikilink 一等支持」**：备选 **Vditor IR 模式**——frontmatter 原生、Typora 式体验开箱即用，但 wikilink 只能降级为「保留原文 + 图谱侧解析」（编辑器内不渲染内链）。这与 r29 把 wikilink 当核心交互的取向不符，故列为备选而非主推。

---

## 2. Obsidian 风格关系图谱

需求：节点点击事件（点节点直接打开对应 md 进编辑器）、与 Vue3 集成、大图性能。

### 2.1 候选对比

| 维度 | **vis-network** | **ECharts graph** | cytoscape | d3-force |
|---|---|---|---|---|
| 节点点击事件 | ✅ 原生 `click`/`selectNode`，`params.nodes` 为 id 数组 | ✅ `chart.on('click')`，需判 `params.dataType==='node'` | ✅ 丰富事件 | ⚠️ 需自写 |
| Vue3 集成 | ✅ `vue-vis-network2`（TS、Composition API、DataSet 响应式） | ⚠️ 需自包 `echarts.init` 生命周期 | ⚠️ 需自包 | ⚠️ 需自包 |
| 大图性能 | ✅ Barnes-Hut 物理（O(n log n)）+ `hideEdgesOnDrag/Zoom` + `clusterThreshold` 自动聚合 | ✅ canvas + `progressive`，千级需手调 | ✅ 万级最强 | ⚠️ 自管理 |
| 布局/样式 | ✅ force 布局开箱即用 | ✅ force/circular | ✅ 布局算法最全 | ⚠️ 全自写 |
| 学习/维护成本 | 低 | 中 | 中高 | 高 |

依据：vis-network [官方文档](https://almende.github.io/vis/docs/network/)（click 事件结构）、[`vue-vis-network2`](https://github.com/D-Sketon/vue-vis-network2)（Vue3+TS 包装）、性能调优见 [vis#3278](https://github.com/visjs/vis/issues/3278)；ECharts graph 性能/事件见 [ECharts 特性页](https://echarts.apache.org/en/feature.html) 与多篇调优实践。

### 2.2 图谱最终推荐

**推荐 vis-network + `vue-vis-network2` 包装**，理由：
1. **点击即开 md 零样板**：`@click="(p) => openMd(p.nodes[0])"`，`params.nodes` 直接给出被点节点 id——正中「点节点打开对应 md」的需求；
2. **obsidian 式 force 布局开箱即用**，无需手写力导；
3. `vue-vis-network2` 提供 TS + `<script setup>` + DataSet/DataView 响应式，贴合已锁 stack；
4. 千级节点可靠 Barnes-Hut + `interaction.hideEdgesOnDrag/hideEdgesOnZoom` + `layout.clusterThreshold` 自动聚合撑住（对应 r29 的「全局图谱需缓存/增量」量级）。

**落地要点：**
```vue
<script setup lang="ts">
import { VueVisNetwork, type Node, type Edge } from 'vue-vis-network2'
const props = defineProps<{ nodes: Node[]; edges: Edge[] }>()
const emit = defineEmits<{ open: [pageId: string] }>()
const options = {
  physics: { solver: 'barnesHut', stabilization: { iterations: 1000 } },
  interaction: { hideEdgesOnDrag: true, hideEdgesOnZoom: true, hover: true },
  layout: { improvedLayout: true, clusterThreshold: 150 },
  nodes: { shape: 'dot', size: 12 },
  edges: { smooth: { enabled: false } }, // 大图关曲线提性能
}
const onClick = (p: { nodes: (string|number)[] }) => {
  if (p.nodes.length) emit('open', String(p.nodes[0])) // 与编辑器 wikilink 点击共用 openMd
}
</script>
<template>
  <VueVisNetwork :nodes="nodes" :edges="edges" :options="options" @click="onClick" />
</template>
```
> 与 r29 对齐：`nodes` 由后端 `GET /wiki/graph` 返回（节点 id 用页面路径/id，`title` 取 frontmatter `paper.title` 优先），ghost 虚节点用不同 `color`/`shape: 'ellipse'` 区分。编辑器内点 wikilink 与图谱点节点**复用同一个 `openMd(pageId)` 回调**，行为一致。

**备选 ECharts graph**：若后续还要在同一页面叠加统计图表（柱/线/饼）想统一一套依赖，ECharts 一套包圆更省；但纯图谱交互（点击/聚合/物理）vis-network 更顺手，且本项目仪表盘已另有图表方案，故图谱单独选 vis-network。

---

## 3. 附带：WS 客户端 + 流式渲染组合

### 3.1 前端 WS 客户端（连 Django Channels）

**推荐：原生 `WebSocket` 封装一个 composable，或用 `@vueuse/core` 的 `useWebSocket`。** 不引入重型客户端库（无 STOMP/Socket.IO 协议开销——Channels 走裸 JSON 帧）。

- 需求仅为：JSON 帧收发、token 认证（Channels 常在 querystring 或首帧带 token）、断线指数退避重连、心跳。
- `@vueuse/core` 的 `useWebSocket` 已内置自动重连 + 响应式 `data`/`status`，与 Vue3 贴合，**是首选**；若想零依赖，自封装一个 ~60 行的 `useWs` composable 也足够。

```ts
// 推荐：@vueuse/core
import { useWebSocket } from '@vueuse/core'
const { data, status, send, close } = useWebSocket(wsUrl, {
  autoReconnect: { retries: () => true, delay: 2000, onFailed: () => {} },
  heartbeat: { message: JSON.stringify({ type: 'ping' }), interval: 30000 },
})
// wsUrl 形如 wss://host/ws/agent/?token=<GATEWAY_TOKEN>（token 认证始终强制，见 spec）
```

### 3.2 流式渲染 + 折叠面板 + markdown 渲染（配 Element Plus）

用于 oc-main 对话的 agent 流式输出（参考现有 `openclaw_service.py` 的 SSE text/done/error 契约，迁移到 WS 后形态不变）。

**组合：`markdown-it`（增量渲染）+ Element Plus `el-collapse` + 代码高亮。**

- **流式 markdown**：每收到一个 token 就 `md.render(累积文本)` 重渲染该消息气泡。`markdown-it` 速度快、对不完整语法容错好，是流式渲染的稳妥选择。依赖 `markdown-it` + `@types/markdown-it`。
- **折叠面板**：思考过程/工具调用 trace 用 EP 的 `el-collapse` / `el-collapse-item` 直接承载，与已锁 UI 库一致，无需第三方。
- **代码高亮**：`markdown-it` 配 `highlight.js` 的 `highlight` 回调即可。
- 若想少写 v-html 指令可用 `vue3-markdown-it` 包装，但直接用 `markdown-it` + 一个 `v-html` 已足够，**不必引入额外抽象**。

```ts
import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js'
const md = new MarkdownIt({
  html: false, linkify: true,
  highlight: (str, lang) =>
    lang && hljs.getLanguage(lang)
      ? hljs.highlight(str, { language: lang }).value
      : '',
})
// 流式：watch(accumulatedText, t => renderedHtml.value = md.render(t))
```

---

## 4. 依赖清单（落地用）

```jsonc
{
  "dependencies": {
    // 编辑器
    "@milkdown/kit": "^7",
    "@milkdown/vue": "^7",
    "@flowershow/remark-wiki-link": "*",   // [[wikilink]]
    "remark-frontmatter": "*",              // YAML frontmatter
    // 图谱
    "vis-network": "*",
    "vue-vis-network2": "*",
    // WS + 工具
    "@vueuse/core": "*",
    // 流式渲染
    "markdown-it": "*",
    "highlight.js": "*"
  },
  "devDependencies": {
    "@types/markdown-it": "*"
  }
}
```

## 5. 风险与注意

1. **Milkdown wikilink 需一段自研 Remark→ProseMirror 映射**（渲染成可点内部链接 mark）。语法解析由 `@flowershow/remark-wiki-link` 完成，自写部分仅 ~1 插件文件。这是主推路径**唯一**的自研点，需在排期里计入。
2. **Vditor 在 Vue3+TS+Vite 下曾有打包问题**（[issue #1018](https://github.com/Vanessa219/vditor/issues/1018)，`vue-tsc` 报类型错）——若最终回退到 Vditor 需重新验证当前版本。
3. **图谱规模**：r29 提到全局图谱需后端缓存/增量。vis-network 千级可撑，但若页面数远超千级，建议后端做聚合/分页下发，前端保持 Barnes-Hut + 关曲线。
4. **frontmatter 双 schema**（r29 §3.4）：编辑器层 `remark-frontmatter` 只负责「保留并忽略」，**解析/着色交给后端与图谱层**，前端编辑器不做 YAML 语义理解，避免重复实现 `_parse_frontmatter` 已有的逻辑。
