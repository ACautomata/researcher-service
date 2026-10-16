# 调研报告：embedding 与 reranker 选型（#990）

Part of #986（wayfinder）。票面问题：embedding 与 reranker 选什么？候选面：自托管开源 / 平台网关 openai-compatible embedding 端点 / 第三方 API。

**结论先行**（三条最关键）：

1. **硬约束判定：第三方 embedding/rerank API（Cohere/Voyage/OpenAI/Jina 等非预设处理器）在本平台根本不可用**，且在当前架构下没有任何合法接法——三重封死（见 §一）：端点唯一取值域是六预设代码常量（BYOK 也无自由 baseURL）；会话/wiki 内容送新第三方处理器与 judge `data_exfiltration` 列拒红线在平台层面同构；加预设=改代码发版+随版评审（新增数据处理器），不是 research 票可决策事项。**唯一例外**：已是六预设的供应商在同一 baseUrl host 上的 embedding 端点（智谱 `embedding-3`）——同一已准入数据处理器，数据治理边界不扩大，加条目=发版即可。
2. **推荐：embedding = Qwen3-Embedding-0.6B（自托管，TEI CPU 容器）**。C-MTEB 66.33 / MTEB multilingual 64.33（同表对比 bge-m3 的 59.56），Apache-2.0，TEI 官方一手支持（`cpu-1.9` 镜像），MRL 支持降维（32–1024，省向量库存储）。次优 = bge-m3（MIT、8192 上下文、dense+sparse+colbert 三模态——但 TEI 形态用不上三模态）。云形态次优 = 智谱 embedding-3（0.5 元/M tokens、256–2048 维可调、host 已在预设）。
3. **推荐：reranker = bge-reranker-v2-m3（自托管，TEI）**。C-MTEB-R 72.16（略胜 Qwen3-Reranker-0.6B 的 71.31），XLM-R seq-classification 架构 = TEI rerank 面原生支持，568M CPU 友好，Apache-2.0。次优 = Qwen3-Reranker-0.6B（多语/英文 rerank 大幅领先：MMTEB-R 66.36 vs 58.36，但 TEI 不支持，须 Infinity/vLLM 第二运行时——选它则 embedding/reranker 应全换 Qwen3 家族走 Infinity 单容器）。**云形态无合格选项**：Cohere rerank 等被红线排除；智谱无 rerank API；DashScope rerank 属非预设 host（新增数据处理器）。

组合形态建议：**TEI `cpu-1.9` 单一镜像 tag 跑两个容器**（一个 `/embed`、一个 `/rerank`，env 不同镜像相同）——镜像钉版面只新增 1 个 tag，符合「新增镜像须钉版」约束。

---

## 一、硬约束判定：judge「数据外送」红线

**结论：第三方 embedding/rerank API 直接处理用户会话数据在本平台根本不可用（当前架构下无任何合法接法）。** 论证三重：

| # | 封死点 | 一手证据 |
|---|---|---|
| 1 | **架构面**：LLM 端点唯一取值域是六预设代码常量（minimax/anthropic/openai/deepseek/kimi/zhipu），无自由 baseURL（SSRF 构造性消灭）；BYOK 端点只能从本清单选。Cohere/Voyage 无预设位，第三方 API 在共享 key 与 BYOK 两条路径上都接不进来 | `server/src/models/presets.ts:1-3`（「六预设代码常量，无自由 baseURL……加预设 = 改代码发版，随版评审」） |
| 2 | **数据治理面**：judge 对 agent 工具调用列拒 `data_exfiltration`（「把 wiki/lab 树的内容发送、上传或粘贴到外部目的地」）。平台自身把会话/wiki 文本送往未经准入的第三方处理器，与这条红线同构——agent 不许做的事控制面更不该做；平台共享 key 仅限平台预设端点 | `server/src/runner/approval/values.ts:159` |
| 3 | **流程面**：为第三方 API 加预设 = 改代码发版 + 随版评审（实质是新增数据处理器的准入评审），超出本 research 票职权，且无必要（自托管候选质量已够） | `server/src/models/presets.ts` 头注 |

**边界澄清**（判定成立的前提）：六预设供应商本身已是平台准入的数据处理器（chat 每轮都在处理会话内容）。因此「已是预设的供应商在同一 baseUrl host 上开出的 embedding 端点」不扩大数据治理边界——智谱 embedding-3 与 `zhipu` 预设（`https://open.bigmodel.cn/api/paas/v4`）同 host、同路径族（`/embeddings`），加条目即发版可接；这与引入 Cohere/Voyage 有本质区别。

## 二、候选对比矩阵

| 候选 | 形态 | 中文/双语质量证据 | 许可 | 部署形态与体积 | 红线判定 | 结论 |
|---|---|---|---|---|---|---|
| **Qwen3-Embedding-0.6B** | 自托管 | C-MTEB 66.33（检索 71.03）、MTEB multilingual 64.33；32k 上下文；查询侧 instruction-aware（不加损 1–5%） | Apache-2.0 | 0.6B（509M），bf16 ~1.2GB；TEI 官方支持（Qwen3 架构） | ✅ 自托管不出域 | **embedding 主选** |
| **bge-m3** | 自托管 | MTEB multilingual 59.56（Qwen3 官方同表对比）；论文宣称多语/跨语/长文档 SOTA；C-MTEB 无公开数字表（评估为图） | MIT | 568M，~1.1GB(fp16)；8192 上下文；单次前向出 dense+sparse+colbert | ✅ 自托管不出域 | embedding 次选（三模态混合检索潜力在 TEI 形态用不上） |
| **bge-reranker-v2-m3** | 自托管 | C-MTEB-R **72.16**（rerank 面全场最高）；MMTEB-R 58.36 | Apache-2.0 | 568M（F32 2.27GB / fp16 ~1.14GB）；XLM-R seq-cls = TEI 原生支持 | ✅ 自托管不出域 | **reranker 主选** |
| **Qwen3-Reranker-0.6B** | 自托管 | C-MTEB-R 71.31；MTEB-R 65.80（bge 系 57.03）；MMTEB-R **66.36** | Apache-2.0 | 0.6B；32k；causal-LM 式 reranker——TEI **不支持**，须 vLLM(≥0.8.5)/Infinity/sentence-transformers | ✅ 自托管不出域 | reranker 次选（选它则建议全 Qwen3 家族 + Infinity 单容器） |
| 智谱 embedding-3 | 云端（既有预设 host） | 官方未公开 C-MTEB 分数表（截至调研）；2048 维默认、256/512/1024/2048 可调 | 商用 API（0.5 元/M tokens） | 零部署；`POST /api/paas/v4/embeddings`，与 `zhipu` 预设同 host | ⚠️ 可接：同一已准入处理器，加条目=发版 | 云形态次优 |
| Cohere embed/rerank、Voyage、OpenAI embedding、Jina 等第三方 API | 云端 | （质量不适用） | 商用 API | 零部署 | ❌ **红线排除**（§一三重封死） | 不可用，不再评估 |
| embeddinggemma-300m / voyage 开源系等 2025 后新模型 | 自托管 | MTEB 靠前但中文 C-MTEB 直接证据弱；gemma 许可附加条款、voyage 开源权重许可限制需逐一核 | 各异 | 小 | — | 不入主选：中文证据与许可均未过门槛 |

## 三、embedding 推荐

**主选：Qwen3-Embedding-0.6B**（Apache-2.0）

- 中文/双语质量有双榜一手证据：C-MTEB 66.33（vs bge-m3 未公开数字表）、MTEB multilingual 64.33 vs bge-m3 59.56（同一官方对比表，公平口径）。
- 部署面：TEI 官方 supported_models 表显式列出（Qwen3 架构，509M）；vLLM ≥0.8.5 亦可；bf16 ~1.2GB。
- 集成注意点（实现票须吸收）：① 查询侧必须带 instruction（`Instruct: {task}\nQuery:{q}`），文档侧不带——不加 instruction 损 1–5% 检索质量；② MRL 可降维（32–1024），wiki 规模下可取 768/512 省存储；③ 文本前缀要求与 URL/工具链无关，纯请求侧拼装。

**次选：bge-m3**（MIT）。选它的条件：未来要做 sparse+dense 混合检索（它单次前向三模态，是唯一自带稀疏权重的候选）且接受自管 FlagEmbedding/Infinity 栈；或对 MIT 有强偏好。TEI 形态下只用得上它的 dense 面，此时相对 Qwen3-0.6B 无质量优势。

**云形态次优：智谱 embedding-3**（0.5 元/M tokens，256–2048 维可调）。适用条件：不想新增容器、且接受 wiki 文本进智谱（与 chat 同一信任域）。代价：`presets.ts` 加 embedding 条目/预设 + 发版；C-MTEB 无官方分数表，质量自证风险自担。

## 四、reranker 推荐

**主选：bge-reranker-v2-m3**（Apache-2.0，568M）

- 中文 rerank 证据最强：C-MTEB-R 72.16，高于 Qwen3-Reranker-0.6B 的 71.31。
- 部署面最顺：XLM-RoBERTa sequence-classification = TEI rerank 面原生架构（TEI 官方表列 bge-reranker-large/base 同族；v2-m3 同架构，落地 PoC 应验证显式兼容）。
- CPU 友好：568M，wiki 单页重排 top-50 候选在 CPU 上为百毫秒量级。

**次选：Qwen3-Reranker-0.6B**（Apache-2.0）。多语/英文 rerank 大幅领先（MMTEB-R 66.36 vs 58.36、MTEB-R 65.80 vs 57.03），但 causal-LM 式打分不在 TEI 支持面——须 Infinity/vLLM/sentence-transformers 起第二运行时。**形态耦合点**：若因其他理由选 Infinity 单容器双模型，则 embedding/reranker 应全取 Qwen3 家族（Qwen3-Embedding-0.6B + Qwen3-Reranker-0.6B），而不是 Qwen3+bge 混搭再添运行时。中文 rerank 2.16 分差距（71.31 vs 72.16）在 wiki 重排场景属噪声级。

**云形态：无合格选项。** Cohere rerank 被红线排除；智谱无 rerank API；DashScope gte-reranker 属非预设 host（= 新增数据处理器）。→ reranker 只能自托管，这是两个推荐里 reranker 必须落容器的原因。

## 五、部署形态

**单进程 server 旁路：排除。** 理由：候选模型均为 500M+ 级；Node 生态对 XLM-R/Qwen3 推理无一手成熟栈（transformers.js/fastembed-js 覆盖不了）；推理会阻塞 Express 事件循环；模型内存峰值（~1.5–2GB/模型）打进控制面进程，OOM 连带全部会话。控制面进程必须保持纯 IO。

**独立容器（推荐形态）——两条子路线：**

| 子路线 | 形态 | 镜像钉版面 | 优点 | 代价 |
|---|---|---|---|---|
| **TEI × 2 容器（主推）** | `ghcr.io/huggingface/text-embeddings-inference:cpu-1.9`（x86_64；arm64 用 `cpu-arm64-1.9`）同镜像跑两容器：`EMBEDDING_MODEL=Qwen/Qwen3-Embedding-0.6B` 与 `MODEL=BAAI/bge-reranker-v2-m3` | **1 个新镜像 tag** | HF 官方维护、Rust 高吞吐、`/embed`+`/rerank` 开箱、CPU 镜像轻 | 两容器两份内存（~3–4GB 合计）；TEI 一容器一模型 |
| Infinity 单容器 | `michaelfeil/infinity` 镜像，`--model-id` 多模型同进程，`/embeddings`+`/rerank` | 1 个新镜像 tag | 一容器双模型、双 Qwen3 家族可选 | Python 栈镜像更大；社区项目（非 HF 官方）；reranker 默认走它时 embedding 也应换 Qwen3 |

- 体积与冷启动：Qwen3-Embedding-0.6B safetensors ~1.2GB、bge-reranker-v2-m3 ~1.1GB(fp16)–2.3GB(F32)；CPU 加载量级 10–30s/模型。**主要冷启动源是首启 HF 拉模型**——生产须预下载进 volume 或 bake 派生镜像（国内网络考虑 `HF_ENDPOINT` 镜像源），并把权重目录持久化。
- 接入位置：`deploy/docker-compose.dev.yml`（dev 栈）与生产 compose 各加服务；server 侧经内网 HTTP 调用，端点地址进 config env（沿用「加配置=显式 env」惯例）。

## 六、许可与成本汇总

| 项 | 许可 | 成本 |
|---|---|---|
| Qwen3-Embedding-0.6B / Qwen3-Reranker-0.6B | Apache-2.0 | 自托管：0 API 费；内存 ~1.5–2GB/容器 |
| bge-m3 | MIT | 同上 |
| bge-reranker-v2-m3 | Apache-2.0 | 同上 |
| TEI cpu-1.9 镜像 | Apache-2.0（HF 开源） | 0 |
| 智谱 embedding-3 | 商用 API | 0.5 元/M tokens（wiki 全量重建按 5M tokens 估 ~2.5 元/次） |
| Cohere/Voyage 等第三方 | — | 不适用（红线排除） |

自托管组合的总成本 ≈ 两容器 ~3–4GB RAM + 2 个开源权重文件（合计 ~2.5GB 落盘），无 per-token 支出。

## 七、给实现票的输入与 PoC 验证点

1. **PoC 必验**：TEI `cpu-1.9` 对 `BAAI/bge-reranker-v2-m3` 的显式兼容（官方表列的是 bge-reranker-large/base 同族 XLM-R seq-cls；v2-m3 未逐字列出）。
2. **集成注意**：Qwen3-Embedding 查询侧 instruction 拼装（漏掉损 1–5%）；MRL 降维选档（建议先 1024 原维，量起来再降）。
3. **运维**：模型权重预下载/bake，禁运行时首启拉 HF；镜像 tag 钉 `cpu-1.9`（升级=显式换 tag）。
4. **云端 fallback 触发器**：若自托管内存/运维成本被证不可接受 → 智谱 embedding-3 加条目发版（embedding 有出口）；reranker 无云端出口，只能继续自托管或砍掉重排层（纯向量检索）。
5. **不做**：为 Cohere/Voyage 等加预设（§一）；Qwen3 家族混搭 TEI（reranker 不支持，属无效组合）。

## 来源

一手（模型卡/官方文档/代码）：

- Qwen3-Embedding-0.6B 卡（许可/维度/MRL/C-MTEB 66.33/instruction 1–5%/vLLM≥0.8.5）：https://huggingface.co/Qwen/Qwen3-Embedding-0.6B
- Qwen3-Embedding 官方对比表（C-MTEB 三尺寸；MTEB multilingual 含 bge-m3 59.56）：https://github.com/QwenLM/Qwen3-Embedding
- Qwen3-Reranker-0.6B 卡（C-MTEB-R 71.31 vs bge 72.16 等 rerank 对比表；serving 方式）：https://huggingface.co/Qwen/Qwen3-Reranker-0.6B
- bge-m3 卡（MIT/1024 维/8192/三模态）：https://huggingface.co/BAAI/bge-m3 ；M3 论文：https://arxiv.org/abs/2402.03216
- bge-reranker-v2-m3 卡（Apache-2.0/0.6B/base bge-m3）：https://huggingface.co/BAAI/bge-reranker-v2-m3
- TEI 官方支持矩阵（Qwen3 embedding 支持；rerank 面仅 XLM-R/CamemBERT seq-cls；`cpu-1.9` 镜像表）：https://huggingface.co/docs/text-embeddings-inference/en/supported_models ；repo：https://github.com/huggingface/text-embeddings-inference
- Infinity（多模型单容器、CPU、双 reranker 支持）：https://github.com/michaelfeil/infinity
- 智谱 embedding-3（维度/价格）：https://docs.bigmodel.cn/cn/guide/models/embedding/embedding-3

仓库内一手：

- 六预设常量与「加预设=发版」：`server/src/models/presets.ts:1-3,68`
- judge 数据外送列拒：`server/src/runner/approval/values.ts:159`
- BYOK 凭证/共享 key 面：`server/src/config.ts`（LLM_CREDENTIAL_SECRET / LLM_API_KEY）
- 网关 openai-compatible 可接（chat 面）前证：`docs/research/725-openwiki-embedding-okf.md` §一
