// OpenAPI 3.1 文档生成（#761）：消费 registry（components + paths），产出纯 JSON 文档对象。
// 文档为静态生成（zod → JSON Schema 在启动期一次完成），无运行时依赖。

import { OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi'
import { registry, buildCodeTableMarkdown } from './components'
import './paths' // 副作用：端点全集注册进 registry

export function buildOpenApiDocument() {
  const generator = new OpenApiGeneratorV3(registry.definitions)
  return generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'researcher-service 控制面 API',
      // 文档契约版本（与产品/镜像版本解耦）：文档面结构变更（端点增删、信封语义变化）时 bump。
      version: '1.0.0',
      description: [
        '科研智能体平台控制面（TS/Express；用户视角 = 会话 / wiki / 模型配置）。本文档由 zod schema 生成（`@asteasolutions/zod-to-openapi`），',
        '请求体校验的单一来源是 `server/src/validation/schemas.ts`，文档与实现零漂移——不手写 openapi.yaml。',
        '',
        '## 全局 #312 信封',
        '',
        '所有 REST 一律 HTTP 200，错误信号在响应体：',
        '',
        '```json',
        '{ "code": 0, "message": "ok", "data": <业务载荷|null> }',
        '```',
        '',
        '- 成功：code=0；失败：code 为五位分层码（下表），message 为总述，data 为结构化补充（如 90002 的 `{field:[errors]}`）或 null（防探测场景恒 null）。',
        '- 「不存在 vs 越权」同码防探测（20040/30040/40040/60040/70040/10041）。',
        '- 例外：`GET /api/v1/figures/{id}/png` 与 `GET /api/v1/figures/{id}/svg` 成功路径直发原生字节（不包信封、不 base64）；错误面仍走信封。',
        '',
        '## 认证',
        '',
        '- 除 login / token/refresh / oauth 骨架与 /api/health 外，全部端点要求 `Authorization: Bearer <access>`（JWT HS256）。',
        '- access 默认 5m 过期；refresh 经 HttpOnly cookie（Path=/api/v1/auth）经 `POST /api/v1/auth/token/refresh` 旋转。',
        '- admin 专属端点（users / trace-logs / auth/register）：非 admin → 10004 或域内防探测码。',
        '',
        '## 错误码段表（由 codes.ts 反射生成）',
        '',
        buildCodeTableMarkdown(),
        '',
        '## 不在本文档',
        '',
        '- SSE 事件流 `GET /api/v1/events`（#773 会话/审批/figure_run 事件传输面，panel_stream cookie 认证）不进 OpenAPI 覆盖面——流式端点语义超出请求/响应文档模型。',
      ].join('\n'),
    },
    servers: [{ url: '/' }],
  })
}
