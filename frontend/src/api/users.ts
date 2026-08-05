// users API —— admin 账号管理（#328 / #340-D，消费 TS 后端 /api/v1/users 4 端点）。
// 信封约定：apiJson 成功时已解包 data；错误抛 ApiError(code)（10041 不存在/越权同码防探测、
// 10042 用户名非法、10043 配额非法、10044 不可禁用自己、20041 用户名冲突）。
import { apiJson } from '@/api/client'

export interface UserRowDTO {
  id: string
  username: string
  email: string | null
  role: string // 'admin' | 'user'
  isActive: boolean
  containerCount: number
  quota: { used: number; limit: number }
  mustChangePassword: boolean
  createdAt: string
}

export interface UsersListDTO {
  users: UserRowDTO[]
}

export function listUsers(): Promise<UsersListDTO> {
  return apiJson<UsersListDTO>('/api/v1/users/')
}

export function createUser(input: {
  username: string
  password: string
  email?: string
  maxContainers?: number
}): Promise<{ id: string; username: string }> {
  return apiJson<{ id: string; username: string }>('/api/v1/users/', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function patchUser(
  id: string,
  patch: { isActive?: boolean; maxContainers?: number },
): Promise<{ id: string; username: string; isActive: boolean; maxContainers: number }> {
  return apiJson(`/api/v1/users/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

// 一次性明文回显（仅此一次，modal 关闭后不可再取）；同时撤销该 user 全部 refresh + C1
export function resetUserPassword(id: string): Promise<{ password: string }> {
  return apiJson<{ password: string }>(
    `/api/v1/users/${encodeURIComponent(id)}/reset-password`,
    { method: 'POST', body: JSON.stringify({}) },
  )
}
