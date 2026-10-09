#!/usr/bin/env node
// npm run docs（#761 文档面入口）：等同 npm run dev 起控制面，启动前打印 API 文档访问入口。
// 文档面随控制面启动（API_DOCS_ENABLED 默认开，装配层可关）；交互式 Swagger UI 在前端 admin
// 子应用内（前端带认证链拉 spec + TryIt 注入 token）——/api/docs 整树是 Bearer + admin 门控，
// 浏览器地址栏直开带不上 Authorization header，会被 10001 拒。

const banner = [
  '',
  '── API 文档入口 ────────────────────────────────────────────',
  '  Swagger UI（交互）： 前端 dev server → http://localhost:5173/admin/ 登录 admin → 「API 文档」页',
  '  OpenAPI JSON：      GET http://localhost:8001/api/docs/openapi.json（Bearer admin token）',
  '  开关：              API_DOCS_ENABLED（默认 true；false → /api/docs 整树 90005）',
  '────────────────────────────────────────────────────────────',
  '',
]
for (const line of banner) console.log(line)

import('node:child_process').then(({ spawn }) => {
  const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'dev'], {
    stdio: 'inherit',
  })
  child.on('exit', (code) => process.exit(code ?? 0))
})
