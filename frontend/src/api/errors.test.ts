// seam: DRF 错误体解析器 —— 修复注册 BUG 的核心：把后端真实校验消息（密码强度等）
// 压平成可读消息，替代旧的写死「用户名可能已存在」。
// 错误体形态来自后端实测（accounts/serializers.py 校验器 + LANGUAGE_CODE=zh-hans）。
import { describe, expect, it } from 'vitest'

import { extractApiError } from '@/api/errors'

describe('extractApiError', () => {
  it('压平字段级多条错误并用分号拼接', () => {
    expect(
      extractApiError(400, { password: ['这个密码太常见了。', '密码只包含数字。'] }),
    ).toBe('这个密码太常见了。；密码只包含数字。')
  })

  it('解析单条字段错误', () => {
    expect(extractApiError(400, { username: ['该字段必须唯一。'] })).toBe('该字段必须唯一。')
  })

  it('解析 serializer 级 non_field_errors', () => {
    expect(extractApiError(400, { non_field_errors: ['用户名或密码错误'] })).toBe(
      '用户名或密码错误',
    )
  })

  it('优先返回 detail（权限/通用）', () => {
    expect(extractApiError(401, { detail: '未登录或登录已过期' })).toBe('未登录或登录已过期')
  })

  it('解析裸字符串数组', () => {
    expect(extractApiError(400, ['第一条', '第二条'])).toBe('第一条')
  })

  it('解析裸字符串', () => {
    expect(extractApiError(400, '服务内部错误')).toBe('服务内部错误')
  })

  it('body 为空/非 JSON 时用状态码兜底', () => {
    expect(extractApiError(500, undefined)).toBe('请求失败（500）')
    expect(extractApiError(500, null)).toBe('请求失败（500）')
    expect(extractApiError(500, {})).toBe('请求失败（500）')
  })
})
