// #14：access_token wire 传输契约的跨语言单一来源 cross-test。
// 契约字面量硬编码在三个运行时（backend Python Channels middleware / server Node values.ts /
// frontend TS），无单一文件。改传输格式（如前缀改名/加版本）须三处同步，否则 WS 握手静默
// 1006/4401。本测试 pin 三者一致，防漂移。vitest 从 frontend/ 运行 → cwd=frontend，上级即仓库根。
// 本测试运行于 Node（vitest 读 server/backend 源码文件）；app tsconfig types 仅 vite/client，
// 三斜线指令加载 @types/node 供 node:fs/path/process 模块类型（不污染 DOM 全局）。
/// <reference types="node" />
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { WS_CHAT_PROTOCOL } from './protocol'

const ROOT = path.resolve(process.cwd(), '..')

describe('access_token wire 契约跨语言单一来源（#14）', () => {
  it('server/src/chat/values.ts 的 WS_CHAT_PROTOCOL 与前端常量一致', () => {
    const src = readFileSync(path.join(ROOT, 'server/src/chat/values.ts'), 'utf8')
    expect(src).toContain(`WS_CHAT_PROTOCOL = '${WS_CHAT_PROTOCOL}'`)
  })

  it('backend/accounts/middleware.py（Python Channels）字面量与前端常量一致（裸 access_token + access_token. 前缀两格式）', () => {
    const py = readFileSync(path.join(ROOT, 'backend/accounts/middleware.py'), 'utf8')
    expect(py).toContain(`'${WS_CHAT_PROTOCOL}'`)
    expect(py).toContain(`'${WS_CHAT_PROTOCOL}.`)
  })
})
