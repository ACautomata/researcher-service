import type { ErrorRequestHandler, Request, Response } from 'express'
import { EnvelopeError } from '../envelope'
import { ContainerDomainError } from '../containers/errors'
import { CODE, defaultMessage } from '../codes'

// 唯一错误面：所有抛出的 EnvelopeError 与未知错都转成 HTTP 200 信封（#312）。
export const envelopeErrorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof EnvelopeError) {
    res.json({ code: err.code, message: err.message, data: err.data })
    return
  }
  // 容器领域错误（#334）：携带信封码，统一转译（替代旧「异常→HTTP 状态码」逐类 catch）。
  if (err instanceof ContainerDomainError) {
    res.json({ code: err.code, message: err.message, data: null })
    return
  }
  // JSON 解析失败（坏 body）→ 90002 校验失败
  if (err instanceof SyntaxError || (err as { type?: string }).type === 'entity.parse.failed') {
    res.json({ code: CODE.VALIDATION_FAILED, message: defaultMessage(CODE.VALIDATION_FAILED), data: null })
    return
  }
  // eslint-disable-next-line no-console
  console.error('[unhandled error]', err)
  res.json({ code: CODE.INTERNAL, message: defaultMessage(CODE.INTERNAL), data: null })
}

// 404 兜底：未匹配路由也走信封（HTTP 200 + 系统码），兑现「所有 REST HTTP 200」。
export function notFound(_req: Request, res: Response): void {
  res.json({ code: CODE.ROUTE_NOT_FOUND, message: defaultMessage(CODE.ROUTE_NOT_FOUND), data: null })
}
