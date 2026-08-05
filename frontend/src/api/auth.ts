// auth API —— 改密端点（#340-A 强制改密流程）。
// 信封约定：成功 data=null；错误抛 ApiError（10002 旧密错 / 90002 校验）。成功后服务端
// 撤销该用户全部 refresh + 清 cookie（R1），调用方须用新密码重新登录建立会话。
import { apiJson } from '@/api/client'

export function changePassword(oldPassword: string, newPassword: string): Promise<void> {
  return apiJson<void>('/api/v1/auth/password/change', {
    method: 'POST',
    body: JSON.stringify({ oldPassword, newPassword }),
  })
}
