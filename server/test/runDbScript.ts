// 测试共享 helper：以子进程跑 schema 脚本（apply-schema / upgrade-schema），DATABASE_URL 指向
// 调用方的临时 SQLite 文件。execFileSync 统一用 process.execPath（进程内 node，不依赖 PATH）；
// stdio pipe 防子进程输出污染 vitest 报告。
import { execFileSync } from 'node:child_process'

export function runDbScript(script: 'apply-schema.mjs' | 'upgrade-schema.mjs', dbPath: string): void {
  execFileSync(process.execPath, [`scripts/${script}`], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
    stdio: 'pipe',
  })
}
