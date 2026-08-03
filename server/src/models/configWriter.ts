// ModelConfigWriter —— provider CRUD 后重渲染 openclaw.json 的写侧 Port（#336）。
//
// 平移 backend/containers/fleet/command.py#rewrite_config 语义：DB（ModelProvider）为单一来源，
// 读该容器全部 provider → ProviderConfigBuilder 合并进模板 base（ConfigRenderer 强制 gateway
// 安全不变量）→ 经 ConfigStore 原子覆盖写 instances/<id>/openclaw.json。OpenClaw watch 热加载
// 生效，无需 restart（#36 已证）。写盘失败抛 ConfigWriteError → DB 事务据此回滚（view/service 层）。
//
// 路由层注入此 Port（AppDeps.models.configWriter）：测试可注入假 writer 测回滚，生产装
// TemplateModelConfigWriter（真模板 + 原子写）。

import { readFile } from 'node:fs/promises'
import { ConfigRenderer } from '../containers/configRenderer'
import { ConfigStore } from '../containers/configStore'
import { ConfigurationError } from '../containers/errors'
import type { FleetConfig } from '../containers/values'
import { ProviderConfigBuilder, type ProviderSpec } from './configBuilder'

export interface ModelConfigWriter {
  // 把 providers 合并进模板 base 后原子写盘（name 仅诊断、id 定 instances/<id>/ 路径，代系绑定 #360）。
  rewrite(opts: { name: string; id: string; providers: readonly ProviderSpec[] }): Promise<void>
}

// 模板写盘依赖面（收窄到所需字段，便于 server.ts 直接传 config.fleet；root 供 ConfigStore 原子写）
export type ModelConfigWriterDeps = Pick<FleetConfig, 'root' | 'templateJson' | 'llmApiKey'>

export class TemplateModelConfigWriter implements ModelConfigWriter {
  private readonly configStore: ConfigStore
  private renderer: ConfigRenderer | null = null

  constructor(private readonly cfg: ModelConfigWriterDeps) {
    this.configStore = new ConfigStore(cfg)
  }

  async rewrite({ name, id, providers }: { name: string; id: string; providers: readonly ProviderSpec[] }): Promise<void> {
    // LLM key 未配置 → 90003（ConfigurationError 携带码）。生产 create 已前置 fail-fast
    // （command.ts 同款），此处兜底防「key 被清空后仍写盘成功、provider 不可用」。
    if (!this.cfg.llmApiKey) throw new ConfigurationError('LLM_API_KEY')
    const renderer = await this.ensureRenderer()
    const merged = new ProviderConfigBuilder().build(renderer.renderDict(), providers)
    await this.configStore.write(name, id, JSON.stringify(merged, null, 2))
  }

  // 惰性读模板 + 缓存（对齐 command.ts ensureRenderer）：ConfigRenderer 构造期解析损坏模板 fail-fast。
  private async ensureRenderer(): Promise<ConfigRenderer> {
    if (!this.renderer) {
      const templateText = await readFile(this.cfg.templateJson, 'utf8')
      this.renderer = new ConfigRenderer(templateText)
    }
    return this.renderer
  }
}
