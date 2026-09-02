// seam: panelWidth —— 面板宽度持久化纯逻辑（issue #668 / spec #667）。
// key 家族 researcher:panel:<owner>:<view>:<panel>:width，按用户 token 隔离
// （chat 草稿 draftOwner/draftStorage 先例：JWT 解 sub/username，malformed 回退 token 本体）。
// 只记宽度——collapsed/popped 态不持久化（每次进页 inline）。Storage 由宿主注入可直测。
import { clampInlineWidth } from '@/panels/triState'

// 从 JWT access token 解出隔离用 owner 身份（payload.sub ?? payload.username）。
// 照 ChatView draftOwner 语义：解析失败回退 token 本体（token 间天然隔离），空 token 回退 'signed-out'。
export function panelOwner(token: string): string {
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const payload = JSON.parse(atob(part.padEnd(Math.ceil(part.length / 4) * 4, '='))) as Record<string, unknown>
    const identity = payload.sub ?? payload.username
    if (typeof identity === 'string' && identity) return identity
  } catch { /* malformed token falls through to token-scoped isolation */ }
  return token || 'signed-out'
}

export function panelWidthKey(owner: string, view: string, panel: string): string {
  return `researcher:panel:${owner}:${view}:${panel}:width`
}

// 读恢复宽度：无 storage / 无值 / 非有限数 → null；有值经钳制返回（存储值可能过期或被手改）。
export function loadPanelWidth(
  storage: Storage | null,
  key: string,
  min: number,
  max: number,
): number | null {
  if (!storage) return null
  const raw = storage.getItem(key)
  if (raw === null) return null
  const width = Number(raw)
  if (!Number.isFinite(width)) return null
  return clampInlineWidth(width, min, max)
}

// 写宽度：storage 缺席静默跳过（隐私模式等）。
export function savePanelWidth(storage: Storage | null, key: string, width: number): void {
  storage?.setItem(key, String(width))
}
