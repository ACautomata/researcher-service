// 插件 web 面契约（#752 §2.4 · #788）：组件注册表 + props 契约。类型极小面——
// 插件 web.ts 经 `@frontend/plugins/api`（或 @plugins 别名侧相对路径）import 本文件。
//
// 单管线约束（R6/#730）：插件组件是归约产物的 custom-render 分支，不是第二条管线——
// 只消费投影输出的 details/input/state，不自行拉取或维护独立状态。

import type { Component } from 'vue'

// 工具渲染 props 契约（对齐 #751 ToolRenderContext 精简）。isPartial 仅实时路径的
// 进行态装饰，回放路径不构造（#730）；stage = 域 run 进行态阶段（figure_run.progress
// 归约产物，#799 story 50 阶段条）——同为进行态装饰，终态/回放不构造。
export interface PluginToolRenderProps {
  /** tool.end details（≤4KB 截断面；JSON 字符串或文本——组件侧自行解析） */
  details: unknown
  input: unknown
  state: 'running' | 'done' | 'error'
  expanded: boolean
  isPartial?: boolean
  stage?: string
  toolCallId: string
}

export interface PluginWebDefinition {
  /** key = 工具名；缺省工具走默认工具行渲染（零成本回退）。 */
  readonly components: Readonly<Record<string, Component>>
}

export function definePluginWeb(definition: PluginWebDefinition): PluginWebDefinition {
  return definition
}
