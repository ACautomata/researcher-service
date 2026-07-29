// containers API —— list/create/remove（spec §9.3 容器管理页后端契约）。
import { apiFetch, apiJson, ApiError } from '@/api/client'

export interface PairingSnapshotDTO {
  status: string
  device_id?: string
  scopes?: string[]
  pairing_request_id?: string
}

export interface InstanceDTO {
  name: string
  port: number
  status: string
  health: string
  image: string
  container_id: string
  created_at: string
  pairing: PairingSnapshotDTO
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
  // 删除幂等：404（他人刚删）不报错
  const resp = await apiFetch(`/api/v1/containers/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  })
  if (!resp.ok && resp.status !== 404) {
    throw new ApiError('删除失败', resp.status)
  }
}
