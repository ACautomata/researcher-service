// 插件目录清单（#752 §1/§4.1 · #788）：编译期静态目录——收录 = 在此显式 import 各插件
// manifest 并加入 PLUGIN_MANIFESTS（两处收录行的 server 侧；前端收录行在
// frontend/src/plugins/index.ts）。不用 glob 自动发现——显式收录行是收录评审的动作面
//（名字冲突、类别正确性、env 需求在 diff 上可见，§1）。
//
// V1 目录仅 AutoFigure（#752 §4.1 目录首成员；#744 §10 票 4 工具包装收口，#792）。
import type { PluginManifest } from '../server/src/plugins/api'
import autofigureManifest from './autofigure/manifest'

export const PLUGIN_MANIFESTS: readonly PluginManifest[] = [autofigureManifest]
