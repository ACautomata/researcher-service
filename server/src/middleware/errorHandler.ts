import type { ErrorRequestHandler, Request, Response } from 'express'
import { EnvelopeError } from '../envelope'
import { CODE, defaultMessage } from '../codes'

// 唯一错误面：所有抛出的 EnvelopeError 与未知错都转成 HTTP 200 信封（#312）。
export const envelopeErrorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof EnvelopeError) {
    res.json({ code: err.code, message: err.message, data: err.data })
    return
  }
  // #858：ContainerDomainError 转译分支随 fleet 域退役删除（sandboxes/wikiContainers 直接
  // 抛 EnvelopeError，域错误全部走上方分支）。
  // JSON 解析失败（坏 body）/ body 超限（entity.too.large，body-parser PayloadTooLargeError）
  // → 90002 校验失败（codex PR#346：超限曾落 90000 未知错误）。
  const errType = (err as { type?: string }).type
  if (err instanceof SyntaxError || errType === 'entity.parse.failed' || errType === 'entity.too.large') {
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
