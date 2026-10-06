// seam: docker daemon 同步探测边界（smokeGating.ts · #791 起只留 probeDockerAvailable——
// 原 T10 AutoFigure smoke 门控随 sidecar 生成链路退役删除）。
// 覆盖：探测成功 → true；CLI 缺失 / daemon 未起 / 无权限 → 静默 false（不抛）。
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}))

import { execFileSync } from 'node:child_process'
import { probeDockerAvailable } from './smokeGating'

const mockExec = vi.mocked(execFileSync)

afterEach(() => {
  vi.restoreAllMocks()
})

describe('probeDockerAvailable (同步 daemon 探测边界)', () => {
  it('docker info 成功 → true', () => {
    mockExec.mockReturnValue(Buffer.from('24.0.7'))
    expect(probeDockerAvailable()).toBe(true)
    expect(mockExec).toHaveBeenCalledWith(
      'docker',
      ['info', '--format', '{{.ServerVersion}}'],
      expect.objectContaining({ stdio: 'ignore' }),
    )
  })

  it('docker info 抛错（CLI 缺失 / daemon 未起 / 无权限）→ false（不抛）', () => {
    mockExec.mockImplementation(() => {
      throw new Error('Cannot connect to the Docker daemon')
    })
    expect(probeDockerAvailable()).toBe(false)
  })
})
