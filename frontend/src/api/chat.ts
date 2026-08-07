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

// deviceToken 持久化回归浏览器 localStorage（ADR 0006 决定 3「每浏览器设备 × 每容器」，见
// chat/deviceAuth.ts 的 createContainerTokenStore）。历史：#425 曾上移服务端 DB（GET/PUT …/pairing/token），
// 违背 ADR 0006 行 53 否决且致切换浏览器匹配不上——已回退，服务端端点同步删除。
