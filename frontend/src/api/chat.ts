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

// #371-1 后端 approve 端点（ADR 0006 B2）：协议机首连遇 PAIRING_REQUIRED{requestId} → 前端自动调本端点
// 完成设备配对（后端容器内 exec `openclaw devices approve <requestId>`；归属门 + 越权同码 20040）。
// 响应 {status:'paired'}；deviceToken 不经 REST（网关经 hello-ok 直接下发浏览器，见 #371 流程图）。
// 调用方（配对编排）只关心成败，返回值类型为 void（响应载荷无消费方）。
export async function approvePairing(name: string, requestId: string): Promise<void> {
  await apiJson<{ status: string }>(
    `/api/v1/containers/${encodeURIComponent(name)}/pairing/approve/${encodeURIComponent(requestId)}`,
    { method: 'POST', body: JSON.stringify({}) },
  )
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

// ---- 多容器配对 bug 修复（用户定案）：deviceToken 上移服务端 DB（Pairing.deviceToken 密文列，
// 按 containerId 一对一），替代原 localStorage（键缺容器维度 → 跨容器共用 → AUTH_DEVICE_TOKEN_MISMATCH）。
// GET 回该容器 token（未配对/网关重置 → null，前端走 bootstrap + 自动配对）；PUT 在 hello-ok 下发
// token 后回传落库。归属门 + 越权/不存在同码 20040；身份密钥对仍留 localStorage（签名握手须本地）。

// 该容器已配对的 deviceToken；未配对（库中无 token）→ null（前端据此走 bootstrap 首连）。
export async function getDeviceToken(name: string): Promise<string | null> {
  const data = await apiJson<{ token?: string | null }>(
    `/api/v1/containers/${encodeURIComponent(name)}/pairing/token`,
  )
  return data?.token ?? null
}

// hello-ok 下发 deviceToken 后回传面板落库（AES 密文）。调用方（onConnectHello）只关心成败。
export async function putDeviceToken(name: string, deviceToken: string): Promise<void> {
  await apiJson<{ status: string }>(`/api/v1/containers/${encodeURIComponent(name)}/pairing/token`, {
    method: 'PUT',
    body: JSON.stringify({ deviceToken }),
  })
}
