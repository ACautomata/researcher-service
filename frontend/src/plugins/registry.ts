// 插件渲染注册表（#752 §2.4 · #788）：工具名 → 自定义组件查找；未注册走默认工具行渲染
//（零成本回退）。生产清单 = index.ts 静态收录（编译期常量）；registerPluginWeb 供测试
// 注入临时注册（生产代码不调用）。
import type { Component } from 'vue'
import type { PluginWebDefinition } from './api'
import { PLUGIN_WEB_DEFINITIONS } from './index'

const definitions: PluginWebDefinition[] = [...PLUGIN_WEB_DEFINITIONS]

export function registerPluginWeb(definition: PluginWebDefinition): void {
  definitions.push(definition)
}

export function unregisterPluginWeb(definition: PluginWebDefinition): void {
  const idx = definitions.indexOf(definition)
  if (idx >= 0) definitions.splice(idx, 1)
}

/** 工具名 → 注册组件；同名多插件先收录者胜（收录评审把关唯一性，V1 单插件无冲突面）。
 *  挂点边界（#752 §2.4）：当前消费点 = ToolLine 展开区一处；「附件卡位」挂载缺数据通道——
 *  media 引用（attachment 事件/attachmentsJson v1）不带 producer 工具名，注册表无路由键可挂，
 *  随首个需要它的插件再扩（map fog；AutoFigure 无实害——figure 结果走 tools[].details 引用
 *  形态，PNG/SVG 由 FigureCard 内部渲染，不进附件面）。 */
export function pluginComponentFor(name: string): Component | undefined {
  for (const definition of definitions) {
    const component = definition.components[name]
    if (component) return component
  }
  return undefined
}
