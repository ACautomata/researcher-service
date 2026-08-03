// ModelConfigWriter —— provider CRUD 后重渲染 openclaw.json 的写侧 Port（#336）。
//
// 平移 backend/containers/fleet/command.py#rewrite_config 语义：DB（ModelProvider）为单一来源，
// 读该容器全部 provider → ProviderConfigBuilder 合并进模板 base（ConfigRenderer 强制 gateway
// 安全不变量）→ 经 ConfigStore 原子覆盖写 instances/<id>/config/openclaw.json（#366：config
// 独立目录 ro bind + OPENCLAW_CONFIG_PATH，目录 bind 下 rename 换 inode 容器内可见）。
// OpenClaw watch 热加载生效，无需 restart（#36 已证）。写盘失败抛 ConfigWriteError → DB 事务
// 据此回滚（view/service 层）。
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

// 模板写盘依赖面（收窄到所需字段，便于 server.ts 直接传 config.fleet；root 供 ConfigStore
// 原子写——config 落 instances/<id>/config 独立目录，见 configStore.ts #366 修复说明）
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
  // #366 修复（codex P2「模板加载错误转译」）：readFile 失败（缺失/EACCES）与 JSON.parse 抛的
  // 裸 SyntaxError 都包成 ConfigurationError（90003）——否则全局错误面把每个 SyntaxError 当
  // body 解析失败误译 90002、文件缺失落 90000，客户端收到错误分类的配置失败信封。
  private async ensureRenderer(): Promise<ConfigRenderer> {
    if (!this.renderer) {
      let templateText: string
      try {
        templateText = await readFile(this.cfg.templateJson, 'utf8')
      } catch (e) {
        throw new ConfigurationError(
          `模板文件读取失败 ${this.cfg.templateJson}: ${(e as Error).message}`,
        )
      }
      try {
        this.renderer = new ConfigRenderer(templateText)
      } catch (e) {
        // ConfigRenderer 构造已把损坏模板转 ConfigurationError（形状断言 C9）→ 原样上抛；
        // JSON.parse 抛的裸 SyntaxError → 包成 ConfigurationError。
        if (e instanceof ConfigurationError) throw e
        throw new ConfigurationError(
          `模板 JSON 解析失败 ${this.cfg.templateJson}: ${(e as Error).message}`,
        )
      }
    }
    return this.renderer
  }
}
