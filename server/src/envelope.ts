import type { Response } from 'express'
import { CODE, defaultMessage } from './codes'

// #312 全局信封：所有 REST 一律 HTTP 200，错误信号搬进响应体。
//   成功 {code:0, message:'ok', data:<业务载荷|null>}
//   失败 {code:<5位码>, message:<总述>, data:null | {field:[errors]}}

export type EnvelopeDetail = { readonly [field: string]: readonly string[] } | null

export interface EnvelopeBody<T = unknown> {
  readonly code: number
  readonly message: string
  readonly data: T | null
}

// 路由/中间件抛出此错误 → 统一由 envelopeErrorHandler 转信封。
// data 用于 90002 字段明细（{field:[errors]}）等结构化补充；防探测场景恒 null。
export class EnvelopeError extends Error {
  constructor(
    public readonly code: number,
    message?: string,
    public readonly data: EnvelopeDetail = null,
  ) {
    super(message ?? defaultMessage(code))
    this.name = 'EnvelopeError'
  }
}

// 便捷工厂（最常用形态：仅码，data=null）
export function fail(code: number, message?: string, data: EnvelopeDetail = null): EnvelopeError {
  return new EnvelopeError(code, message ?? defaultMessage(code), data)
}

// 成功响应快捷函数
export function ok<T>(res: Response, data: T, message = defaultMessage(CODE.OK)): void {
  const body: EnvelopeBody<T> = { code: CODE.OK, message, data }
  res.json(body)
}
