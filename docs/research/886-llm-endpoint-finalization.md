# #886 LLM 端点重构收口核查

规格来源：#880 / #886。终态决策见 [ADR 0017](../adr/0017-llm-endpoint-presets-byok.md)，插件上游契约 amendment 已落 [752 §5](752-plugin-system.md#5-配置面)。

## 旧词汇清扫范围

现役源码、部署模板、领域参考与开发 env 示例中，下列检索零匹配：

```sh
rg -n 'RUNNER_JUDGE|ALLOW_PRIVATE_PROVIDER_ENDPOINTS|credentialEnvId|credential_env_id|provider_endpoints' frontend/src server/src deploy docs/agents server/.env.example
```

全库历史记录保留有意例外，避免破坏迁移与决策溯源：

- `server/scripts/lib/incremental-schema.mjs`：旧列/旧表用于 v15→v16 copy-rebuild 与 DROP。
- `server/test/providerMigration.test.ts`、schema 测试：旧库 fixture 与旧列/表消失断言。
- `server/prisma/schema.prisma`：明确标注旧列退役的历史注释。
- `server/src/codes.ts`：40042 常量保留防复用，未用于现役端点放行；90002 仍是字段校验码。
- `docs/research/`、`docs/adr/`：历史规格及显式 supersede/退役记录。
- 路径、shell 命令、插件 stage 等名单属于现役审批或注册校验，不是端点放行机制。

此次移除开发模板逃生开关指导、规则层端点校验叙述、已删除模块导航及过期配置测试标题；没有删除迁移 fixture 或历史规格。
