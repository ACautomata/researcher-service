// B3 原型（#933）共享内存态——一次性原型代码，勿引为生产实现。
// 纯 mock 只读：模型/强度选择只落本模块内存 ref，绝不写 Session.preferredModelJson、
// 不调任何写端点；附件仅本地采集预览（对象 URL），不触发真实上传。
// 变体间共享同一份状态：切 A/B/C 时选中的模型与强度保持，便于横向对比。

import { computed, ref } from 'vue'
import { B3_EFFORT_STOPS, b3OptionOf } from './b3Presets'

// 原型总闸：仅 dev server 生效——生产构建（PROD）与 vitest（MODE==='test'）下整体惰性，
// 包装层直接渲染原版 ChatComposer，切换条也不挂载。
export const B3_ACTIVE: boolean = import.meta.env.DEV && import.meta.env.MODE !== 'test'

export type B3VariantKey = 'A' | 'B' | 'C'

export const B3_VARIANTS: readonly B3VariantKey[] = Object.freeze(['A', 'B', 'C'])

function b3VariantFromUrl(): B3VariantKey | '' {
  if (!B3_ACTIVE || typeof window === 'undefined') return ''
  const v = new URLSearchParams(window.location.search).get('variant')
  return v === 'A' || v === 'B' || v === 'C' ? v : ''
}

// 当前变体（'' = 原版 composer）；初始值取自 URL ?variant=，刷新稳定、链接可分享。
export const b3Variant = ref<B3VariantKey | ''>(b3VariantFromUrl())

// 会话模型覆盖（mock）——null = 默认（清空覆盖，同 /model default 语义）。
export const b3SelectedModel = ref<{ providerId: string; modelId: string } | null>(null)

// 推理强度三档（mock），默认「标准」。
export const b3Effort = ref<0 | 1 | 2>(1)

export const b3ActiveOption = computed(() => b3OptionOf(b3SelectedModel.value))

// 「将写入（mock）preferredModelJson」的只读预览——把 per-session 生效语义摆到台面上，
// 供用户对着实物反应，实际不落库。
export const b3OverrideText = computed(() => {
  const o = b3ActiveOption.value
  if (!b3SelectedModel.value) return '（默认——清空覆盖，同 /model default）'
  const base = { providerId: o.providerId, modelId: o.modelId }
  if (o.capability === 'none') return `${JSON.stringify(base)}（无 effort 通道）`
  return JSON.stringify({ ...base, effort: B3_EFFORT_STOPS[b3Effort.value].wire })
})

// ---- mock 附件采集（对象 URL 本地预览，不触端点；上限口径与正式一致：4 个 / 单文件 ≤100MB）----
export interface B3MockAttachment {
  key: number
  fileName: string
  size: number
  previewUrl: string
}

export const b3MockAttachments = ref<B3MockAttachment[]>([])

let b3AttachKey = 0

export function b3AddMockAttachments(files: File[]): string | null {
  for (const file of files) {
    if (b3MockAttachments.value.length >= 4) return '最多 4 个附件（原型上限与正式一致）'
    if (file.size > 100 * 1024 * 1024) return `${file.name}：单文件 ≤100MB`
    b3MockAttachments.value.push({
      key: ++b3AttachKey,
      fileName: file.name,
      size: file.size,
      previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : '',
    })
  }
  return null
}

export function b3RemoveMockAttachment(key: number): void {
  const found = b3MockAttachments.value.find((p) => p.key === key)
  if (found?.previewUrl) URL.revokeObjectURL(found.previewUrl)
  b3MockAttachments.value = b3MockAttachments.value.filter((p) => p.key !== key)
}
