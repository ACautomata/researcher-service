// chat pairing + bootstrap-token API（issue #40 / spec §8.1 + ADR 0006 D1 / #369）。
// GET 查询配对状态；POST 触发/重试配对（paired/pending/error 三态出参）。
// GET/POST …/bootstrap-token：所有权门控发放容器 bootstrap token（协议机首连凭证，ADR 事实 2）。
// #369：会话 CRUD/历史/命令不再经后端 REST 代理（#339 作废），改走官方协议机 RPC（chat/gatewayChat.ts）。
import { apiJson } from '@/api/client'

export interface PairingDTO {
  status: string // unpaired / pending / paired / error
  device_id?: string
  scopes?: string[]
  pairing_request_id?: string
  detail?: string
}

export function getPairing(name: string): Promise<PairingDTO> {
  return apiJson<PairingDTO>(`/api/v1/containers/${encodeURIComponent(name)}/pairing/`)
}

export function triggerPair(name: string): Promise<PairingDTO> {
  return apiJson<PairingDTO>(`/api/v1/containers/${encodeURIComponent(name)}/pairing/`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
}

// 容器 bootstrap token（ADR 0006 D1）：后端验 JWT + 归属门后返回该容器 GATEWAY_TOKEN，
// 浏览器协议机首连凭证。越权/不存在 → 20040（同码防探测）。
// 信封：server ok(res, { bootstrapToken }) → {code:0, message, data:{bootstrapToken}}；
// apiJson 成功时已解包 data（PR #370 第四轮 R4-1），故此处直接拿业务载荷。缺失即抛错（首连
// token 恒 undefined 会让协议机首连帧 auth.token 为空 → 网关拒 AUTH_BOOTSTRAP_TOKEN_INVALID）。
export async function getBootstrapToken(name: string): Promise<string> {
  const data = await apiJson<{ bootstrapToken?: string }>(
    `/api/v1/containers/${encodeURIComponent(name)}/bootstrap-token`,
    { method: 'POST', body: JSON.stringify({}) },
  )
  const token = data?.bootstrapToken
  if (!token) throw new Error('bootstrap-token 响应缺少 data.bootstrapToken（信封形状不匹配）')
  return token
}
