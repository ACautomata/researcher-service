// containers API —— list/create/remove（spec §9.3 容器管理页后端契约）。
// T0 #801：配对快照/升级判定随 legacy 链退役（设备配对/升级编排删除）——读面只剩 5 态机摘要；
// port 列保留记账（恒 0，端口池废除），UI 不再展示。
import { apiJson } from '@/api/client'

export interface InstanceDTO {
  name: string
  port: number
  status: string
  health: string
  image: string
  container_id: string
  created_at: string
}

export function listInstances(): Promise<InstanceDTO[]> {
  return apiJson<InstanceDTO[]>('/api/v1/containers/')
}

export function createInstance(name: string): Promise<InstanceDTO> {
  return apiJson<InstanceDTO>('/api/v1/containers/', {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
}

export async function removeInstance(name: string): Promise<void> {
  // 经 apiJson：TS 后端越权/不存在删除恒 HTTP 200 + code:20040（同码防探测）——旧 apiFetch+resp.ok
  // 把它当成功（删非属主容器「成功」，PR #370 第四轮 #9 P0）。apiJson 对 code!==0 抛 ApiError，
  // 调用方（ContainersView）据 toast 提示失败。重删（已 removing）也返 20040 → 抛错，可接受
  //（容器确已不在）；name 非法 → 90002。
  await apiJson<void>(`/api/v1/containers/${encodeURIComponent(name)}`, { method: 'DELETE' })
}
