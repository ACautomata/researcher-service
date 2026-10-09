// modelsJson 解码单一实现（#880 review 收敛：models/service、runner/providerRegistry、
// plugins/assignments 三处复制面合一）。宽进严出：坏 JSON / 非对象条目 → 过滤回退空集
//（读面不炸，管理面可修；写侧 zod 已挡源头）。

// 解码端点模型列表（ModelProvider.modelsJson）。条目保序原样保留（展示元数据不裁剪）。
export function parseModelsJson(raw: string): Array<Record<string, unknown>> {
  try {
    const v: unknown = JSON.parse(raw)
    if (Array.isArray(v)) return v.filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
  } catch {
    // 坏 JSON → 空模型列表
  }
  return []
}

// 端点模型 id 集（插件指派写侧「model_id 须属端点模型集」的取值域）。
export function modelIdsFromJson(raw: string): string[] {
  return parseModelsJson(raw)
    .map((m) => m.id)
    .filter((id): id is string => typeof id === 'string')
}
