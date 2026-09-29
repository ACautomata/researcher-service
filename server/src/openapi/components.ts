// OpenAPI registry 与全局共享组件（#761 · wayfinder #750 票 761）。
//
// Registry 模式：zod schema 注册为组件、路径声明引用同一份 zod —— 请求体校验与文档描述
// 单一来源零漂移（票内核心约束：不手写 openapi.yaml 第二来源）。本文件是 registry 的唯一
// 持有者：paths.ts 注册路径、document.ts 生成文档，共用本实例。

import { z } from 'zod'
import { OpenAPIRegistry, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'
import { CODE, DEFAULT_MESSAGE } from '../codes'

// zod v3 打 OpenAPI 补丁（幂等）：给 ZodType 挂 .openapi()，register/registerPath 内部分 schema 走它。
extendZodWithOpenApi(z)

export const registry = new OpenAPIRegistry()

// ---- 共享组件 ----

// 错误信封（#312）：所有 REST 端点的错误面同形状（HTTP 恒 200，错误信号在 body）。
// 具体可能码逐端点写在响应 description；全局码段表由下方 buildCodeTableMarkdown 从
// codes.ts 反射生成（演进零漂移）。
export const ErrorEnvelope = z.object({
  code: z.number().int().describe('五位分层错误码（见全局码段表）'),
  message: z.string().describe('人类可读总述'),
  data: z
    .unknown()
    .nullable()
    .describe('结构化补充（如 90002 的 {field:[errors]}）；防探测场景恒 null'),
})
registry.register('ErrorEnvelope', ErrorEnvelope)

// 宽松成功载荷：响应 data 由路由手写构造（无 zod 单一来源可引用），文档不伪精确 ——
// 逐端点 data 字段在响应 description 文字描述。漂移防线是 review + 本注记，不是伪造 schema。
export const LooseData = z.record(z.string(), z.unknown()).describe('业务载荷；逐字段见响应描述')
export const NullData = z.null().describe('无业务载荷（恒 null）')

// 成功信封构造器（#312）：HTTP 恒 200，code 恒 0。
export function okEnvelope(dataSchema: z.ZodTypeAny): z.ZodTypeAny {
  return z.object({ code: z.literal(0), message: z.string(), data: dataSchema })
}

// 认证方案：JWT Bearer（access token）。除 /api/health、login、token/refresh、oauth 骨架外
// 的全部端点要求；admin 端点叠加 requireAdmin（非 admin → 10004 或域内防探测码）。
export const bearerAuth = registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
})

// 码段表 markdown：由 codes.ts 单一来源反射生成（嵌入 info.description，码表增删改零漂移）。
export function buildCodeTableMarkdown(): string {
  const rows = (Object.entries(CODE) as [string, number][])
    .sort((a, b) => a[1] - b[1])
    .map(([name, code]) => `| ${code} | ${name} | ${(DEFAULT_MESSAGE[code] ?? '').replaceAll('|', '\\|')} |`)
  return ['| 码 | 常量 | 含义 |', '| --- | --- | --- |', ...rows].join('\n')
}
