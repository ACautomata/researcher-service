// chat pairing API —— 设备配对控制面（issue #40 / spec §8.1）。
// GET 查询配对状态；POST 触发/重试配对（paired/pending/error 三态出参）。
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
