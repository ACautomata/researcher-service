// 插件 web 面收录清单（#752 §1/§4.1 · #788）：收录 = 在此显式 import 各插件 web.ts
//（@plugins/* 别名 → 仓库根级 plugins/<id>/web.ts）并加入 PLUGIN_WEB_DEFINITIONS 一行。
// 不用 glob 自动发现——显式收录行是收录评审的动作面（与 server 侧 plugins/index.ts 成对）。
//
// V1 目录仅 AutoFigure 一个成员（#752 §4.1）；#799 收录其 web.ts + FigureCard.vue。
import type { PluginWebDefinition } from './api'
import autofigureWeb from '@plugins/autofigure/web'

export const PLUGIN_WEB_DEFINITIONS: readonly PluginWebDefinition[] = [autofigureWeb]
