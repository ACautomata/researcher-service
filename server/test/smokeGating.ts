// 真 docker daemon 门控探测（#791：原 T10 AutoFigure smoke 门控随 sidecar 生成链路退役删除
// ——唯一消费者 figuresSmoke.test.ts 已删，本文件只留 probeDockerAvailable，现役消费者 =
// sandboxSmoke / wikiContainerSmoke）。

import { execFileSync } from 'node:child_process'

// 同步探测 docker daemon 可达（不抛：CLI 缺失 / daemon 未起 / 无权限 → false）。
// stdio:'ignore' 不向测试输出泄漏 daemon 噪声；timeout 防 UNIX socket 连接挂起。
export function probeDockerAvailable(timeoutMs = 5_000): boolean {
  try {
    execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
      stdio: 'ignore',
      timeout: timeoutMs,
    })
    return true
  } catch {
    return false
  }
}
