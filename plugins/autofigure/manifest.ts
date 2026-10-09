// AutoFigure 插件 manifest（#792 · #744 §10 票 4 · #752 §2.1 声明式总形）。
// 目录首成员：默认未启用、owner 目录一键启用（#749 Q16）；figure 工具 = domain 类别先例
//（不进三层漏斗——输入是纯文本描述，#744 §4.1）；/figure = {execute} outcome 先例
//（#752 R9，两条触发面一条执行面）。实现体在 server.ts。

import { definePlugin } from '../../server/src/plugins/api'
import { z } from '../../server/src/plugins/autofigureDeps'
import {
  FIGURE_COMMAND_NAME,
  FIGURE_TOOL_NAME,
  METHOD_TEXT_MAX,
  executeFigureGenerate,
  figureCommandHandler,
  figureToolDescription,
} from './server'

export default definePlugin({
  id: 'autofigure',
  name: 'AutoFigure',
  description: '方法示意图生成（AutoFigure-Edit 流水线：生图 → SAM3 分割 → SVG 模板 → 组装 → 预览）',
  version: '1.0.0',
  // LLM 需求声明位（#883 T3）：声明即入 Model 页插件指派区——用户可为本插件的 SVG 模板
  // 多模态调用单独指派端点与模型。defaultModel 省略：合理缺省 = 用户默认链 primary
  //（#744 §6 既有语义），部署相关不硬编码模型 id。
  llm: {
    description: 'SVG 模板多模态生成（方法图管线的 LLM 调用段）',
  },
  tools: [
    {
      name: FIGURE_TOOL_NAME,
      description: figureToolDescription,
      category: 'domain',
      parameters: z.object({
        method_text: z
          .string()
          .min(1)
          .max(METHOD_TEXT_MAX)
          .describe('The method description text to visualize as a figure'),
      }),
      promptSnippet: 'generate an editable SVG method figure from a textual method description (returns a figureId reference)',
      promptGuidelines: [
        `Call ${FIGURE_TOOL_NAME} with method_text describing the figure to generate; the result carries a figureId referencing the stored SVG (render/preview via GET /api/v1/figures/<figureId>/svg).`,
        'The generation runs a fixed pipeline (image generation, segmentation, SVG templating) and may take a while; do not call it repeatedly for the same request.',
      ],
      execute: executeFigureGenerate,
    },
  ],
  commands: [
    {
      name: FIGURE_COMMAND_NAME,
      description: '从方法描述文本生成示意图（AutoFigure）',
      handler: figureCommandHandler,
    },
  ],
  // 面板级配置（#744 §6/§11.1 · #752 §5 R7）：启动期全目录完备性校验（生产 fail-fast /
  // dev 警告），运行时缺失在工具执行面明确报错。V1 语义 = 启动校验依据 + 文档。
  configSchema: {
    env: [
      { name: 'AUTOFIGURE_IMAGE_MODEL', description: '生图模型名（面板级，如 image-01）' },
      { name: 'AUTOFIGURE_IMAGE_API_KEY', description: '生图 API key（面板级服务端凭证）' },
      { name: 'AUTOFIGURE_IMAGE_BASE_URL', required: false, description: '生图 API base URL（缺省 https://api.minimax.io）' },
      { name: 'FAL_KEY', description: 'fal key（SAM3 分割 / RMBG 去背景云 API）' },
      // 废弃标记（#883）：面板级 env pin 优先级仍最高（兼容面），退役随插件 LLM 指派票收口——
      // 用户应在 Model 配置页为插件指派端点与模型（缺省跟随默认链）。
      { name: 'AUTOFIGURE_SVG_MODEL', required: false, deprecated: true, description: 'SVG 模板多模态模型 id（废弃；改用 Model 页插件 LLM 指派，缺省 = owner 默认链 primary 模型）' },
    ],
  },
})
