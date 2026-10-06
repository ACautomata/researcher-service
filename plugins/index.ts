// 插件目录清单（#752 §1/§4.1 · #788）：编译期静态目录——收录 = 在此显式 import 各插件
// manifest 并加入 PLUGIN_MANIFESTS（两处收录行的 server 侧；前端收录行在
// frontend/src/plugins/index.ts）。不用 glob 自动发现——显式收录行是收录评审的动作面
//（名字冲突、类别正确性、env 需求在 diff 上可见，§1）。
//
// V1 目录仅规划 AutoFigure（#752 §4.1「目录首成员」，迁移归 #753 / #744 实施拆分），
// 当前为空：骨架校验 / REST / 启用装配 / 漏斗路由全链以测试 fixture 插件覆盖
//（server/test/pluginsRegistry.test.ts 等）。
import type { PluginManifest } from '../server/src/plugins/api'

export const PLUGIN_MANIFESTS: readonly PluginManifest[] = []
