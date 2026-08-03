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

import { readFile, access } from 'node:fs/promises'
import path from 'node:path'
import { CODE } from '../codes'
import { ConfigRenderer } from '../containers/configRenderer'
import { ConfigStore } from '../containers/configStore'
import { ConfigurationError, ContainerDomainError } from '../containers/errors'
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
    // #366 codex 三轮 P1「升级路径」：旧代容器 fail-fast（见 ensureLegacyCompatible）。
    await this.ensureLegacyCompatible(id)
    const renderer = await this.ensureRenderer()
    const merged = new ProviderConfigBuilder().build(renderer.renderDict(), providers)
    await this.configStore.write(name, id, JSON.stringify(merged, null, 2))
  }

  // #366 codex 三轮 P1：父版本（master/1d998cd，config 落 instances/<id>/openclaw.json 单文件 ro
  // bind、无 OPENCLAW_CONFIG_PATH）创建的容器没有 instances/<id>/config 目录。升级后对旧容器 provider
  // 写盘落新路径（不在容器 mount 内）→ 热加载断链但 API 报成功。fail-fast：目录缺失 → 90003（与写盘
  // 失败同域信封）提示重建；service 事务据此次异常回滚 DB 行，盘=DB 不发散。ENOENT 才判旧代——其余
  // fs 错误（EACCES 等）上抛，让写入阶段如实暴露，不误标「旧代」。
  // create 流程不经过本 writer（createComplete 直连 ConfigStore），且新代 create 必建该目录，故只拦旧代。
  private async ensureLegacyCompatible(id: string): Promise<void> {
    const configDir = path.join(this.cfg.root, 'instances', id, 'config')
    try {
      await access(configDir)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ContainerDomainError(
          CODE.LLM_NOT_CONFIGURED,
          `容器为旧版本（缺 ${configDir} 目录），模型配置无法热加载到运行中的容器——请重建该容器后再配置`,
        )
      }
      throw e
    }
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
