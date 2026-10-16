# 调研报告 B1：2024–2026 工业级混合检索管线最佳实践（历史会话混合 RAG 召回）

> 调研窗口 2024–2026；方法：一手来源（arXiv 论文、官方 docs、厂商工程博客）网络调研。
> 目标系统约束：单进程 Express + SQLite 控制面（禁新增向量库/ES 服务）；每消息无条件触发的同步检索链路（预算 ~≤800ms p50）；中文主导语料；检索范围硬隔离（sessions.ownerId 过滤 + 可选时间/会话过滤）。
> 前置事实：仓库已调研确认共享 `LLM_API_KEY` 的 OpenAI 兼容网关可做 embedding（`docs/research/725-openwiki-embedding-okf.md`）。

---

## 0. TL;DR：推荐管线形状

| 层 | 选型 | 候选数 | 延迟估算（p50） | 对照硬约束 |
|---|---|---|---|---|
| ① 查询构造 | **无 LLM 改写**：拼接上一轮 assistant/user 消息（≤2 轮窗口）做指代消解的规则化替代；可选异步「会话摘要改写」旁路（不挡主链路） | — | 0ms（热路径） | 不引入 LLM 调用，保住 800ms 预算 |
| ② 稀疏通道 | SQLite FTS5，**trigram tokenizer**（或写入期外置分词到影子列 + unicode61） | top-50 | 1–10ms（同进程，ownerId 在 SQL WHERE 前置） | SQLite 内建，零新服务；trigram 解决中文不分词 |
| ③ 稠密通道 | sqlite-vec `vec0` 虚表 + OpenAI 兼容网关 embedding API（中文模型首选 bge-m3 / Qwen3-Embedding 系，依网关目录） | top-50 | **50–300ms**（网络 API 主导，单查询一次调用） | 进程内扩展，无独立向量服务 |
| ④ 结构化过滤 | **前置过滤**（索引层）：FTS5 SQL `WHERE ownerId=?` join；vec0 `WHERE owner_id=?`（或 partition key） | — | ~0ms 附加 | 隔离是硬需求；证据支持 filter-inside-search 而非后过滤 |
| ⑤ 融合 | **RRF（k=60）**，两路（稀疏+稠密）； ownerId 过滤在两路候选生成前完成 | 50+50 → 融合 top-24 | <1ms（纯内存计算） | 无超参敏感、无分数归一化问题；学习型融合在本约束不可行 |
| ⑥ 精排/rerank | **主路径：网关 rerank API**（bge-reranker-v2-m3 / Qwen3-Reranker / Cohere Rerank 3.5，依网关目录）；**降级路径：无可用 API 时 RRF 融合分直接精排（省略 rerank 层）** | rerank top-24 → final top-8 | API 路径 **110–250ms**（24 条 ×128–512 tok 实测基准）；降级路径 0ms | 无本地 GPU → 只能 API；候选数按实测延迟定 24 而非 100 |
| ⑦ 注入 agent loop | final top-8 会话片段（含 sessionId/timestamp 元数据）注入 | 8 | — | — |

**端到端预算**：0 + (50–300) + (1–10) + <1 + (110–250) ≈ **160–560ms p50**；p95 由 embedding/rerank API 尾延迟主导（见 §3.4、§7 开放问题），必须给每层设超时 + rerank 层可跳过的降级开关。

**延迟预算分解与降级动作**（每层带超时与 fallback，保证「检索必返回、绝不超支」）：

| 层 | p50 | p95 | 软超时 | 超时/失败降级动作 |
|---|---|---|---|---|
| 规则化查询拼接 | 0ms | 0ms | — | — |
| embedding API（1 次调用） | 100–300ms | ~600ms | 300ms | 降级纯稀疏通道（FTS5 单路 top-24），标记 `degraded=true` |
| FTS5 trigram 查询 | 1–5ms | <20ms | 50ms（不该触到） | 返回空稀疏路（单路稠密继续） |
| sqlite-vec KNN | 1–5ms | <20ms | 50ms | 返回空稠密路（单路稀疏继续） |
| RRF 融合 | <1ms | <1ms | — | — |
| rerank API（24 候选 ×≤512 tok） | 110–250ms | ~500ms | 300ms | 丢弃 rerank，按 RRF 序取 top-8 |
| **合计** | **≈160–560ms** | **≈700–1200ms** | 700ms 总闸 | 任一层超时即走对应降级；最坏情形 = 纯稀疏 + RRF 序，<30ms |

**关键决策一句话**：两路召回（FTS5-trigram + sqlite-vec）→ ownerId 前置过滤 → RRF → API rerank（可降级），不加 LLM 查询改写、不上 ColBERT 多向量、不建独立记忆图谱服务；会话条目保留「逐字消息块 + 时间戳元数据」为主层，异步抽取的记忆条目为辅层。

**明确不做清单（negatives，与推荐同等重要）**：

| 不做 | 理由（证据锚点） |
|---|---|
| LLM 查询改写/多查询/HyDE 入热路径 | 每消息 +1~N 次 LLM 调用（300ms–2s），破预算（§4.1）；HyDE 在「同作者语料」场景处负收益区 |
| ColBERT/BGE-M3 多向量通道 | per-token 向量在 SQLite 存储形态不可行；CPU 延迟数百 ms（§3.3） |
| SPLADE 学习型稀疏 | 索引期需逐文档编码模型调用，写入成本不可控（§1.1） |
| 独立记忆服务（Zep 托管/Mem0 云/独立图谱库） | 违反 SQLite-only；其可取机制（异步抽取、时序、两层分离）以内嵌形态吸收（§6.2） |
| 学习型融合（LTR/TRF） | 需标注数据+训练+服务设施；RRF 的 k 不敏感性使调参需求近乎为零（§2.2） |
| HNSW 类近似索引 | 单用户/单租户语料量级下暴力扫描毫秒级，无必要（sqlite-vec 社区实测，§1.1） |

---

## 1. 混合通道：稀疏 × 稠密 × 结构化过滤

### 1.1 方法对比与证据

**为什么稀疏+稠密互补（2024–2026 证据一致）**：

- Anthropic 工程博客（2024-09）：对知识库 chunk 检索，「contextual embeddings 单独」把 top-20 检索失败率从 5.7% 降到 3.7%（**-35%**）；「contextual embeddings + contextual BM25」降到 2.9%（**-49%**）；叠加 Cohere rerank 后 1.9%（**-67%**）。这是厂商侧最直接的「BM25 与 dense 叠加仍各自贡献」一手证据。[anthropic.com/engineering/contextual-retrieval](https://www.anthropic.com/engineering/contextual-retrieval)
- IBM Blended RAG（arXiv 2404.07220，被引 300+）：在 QUAC/MixedQA（对话式问答语料，与本系统「历史会话」场景同型）上，dense + sparse encoder 混合 query + cross-encoder rerank 拿到 **88.77% top-10 检索准确率**，显著优于任一单通道与常规混合。[arxiv.org/abs/2404.07220](https://arxiv.org/abs/2404.07220)
- 互补机理：BM25 精确词项匹配占优——专有名词、标识符、代码串、领域术语；dense 在语义改写/词汇失配（vocabulary mismatch）上占优。两通道失败模式系统性互补（[mbrenndoerfer.com 综述](https://mbrenndoerfer.com/writing/hybrid-search-bm25-dense-retrieval-fusion)、[Elastic what-is hybrid search](https://www.elastic.co/what-is/hybrid-search)、金融域基准 [arXiv 2604.01733](https://arxiv.org/html/2604.01733v1)）。会话语料中大量「文件名、报错串、命令、人名」恰是 BM25 强区。

**按查询类型的通道胜率（会话语料映射，综述归纳 + 基准佐证）**：

| 查询类型（本系统实例） | 稀疏 BM25/FTS5 | 稠密 dense | 判定 |
|---|---|---|---|
| 专名/精确串（文件名、报错码、命令、模型名） | ✅ 强 | ⚠️ 弱（词表失配） | 稀疏路存在价值的最硬证据 |
| 同义改写（「上次那个登录问题」vs 原文「auth 模块 401」） | ❌ 无命中 | ✅ 强 | 稠密路价值 |
| 时间型（「上周聊过的部署方案」） | ⚠️ 需时间过滤列 | ⚠️ 弱 | 两者都弱 → 元数据过滤 + 时间锚是主力（§6.2.4，arXiv 2601.00821 时间类数据） |
| 短指代（「那个怎么办」） | ❌ | ⚠️（需上下文拼接后才行） | 查询面规则拼接的必要性（§4.2） |
| 多语言混杂（中英穿插会话） | ⚠️ trigram 可跨 | ✅ 多语 embedding 强 | 双通道互补在中文会话场景额外成立 |
- SPLADE 系学习型稀疏（SPLADE-v3，arXiv 2403.06789）在 BEIR 上显著超 BM25，但其需要**索引期跑稀疏编码模型**（每文档前向推理），本约束下只能走网关 API 逐文档编码，写入成本与延迟不可控——不推荐；BM25/FTS5 是本约束下的稀疏通道合理形态。[alphaxiv.org/abs/2403.06789](https://www.alphaxiv.org/abs/2403.06789)

**结构化过滤（ownerId/时间）放索引层还是后过滤**：

- 工业界共识是**过滤参与检索过程本身（filter-inside-search），而非取回后再过滤**。Qdrant 官方将其实现为 filterable HNSW/查询规划器，并明确「Qdrant 既不做纯 pre-filter 也不做纯 post-filter，而是在图遍历中感知过滤条件」，后过滤在选择性高时会导致结果不足、前置过滤在全量扫描语义下浪费算力。[qdrant.tech/blog/pre-filtering-vs-post-filtering](https://qdrant.tech/blog/pre-filtering-vs-post-filtering/)、[qdrant.tech/documentation/search-patterns/vector-search-filtering](https://qdrant.tech/documentation/search-patterns/vector-search-filtering/)
- 本约束下的落地：SQLite 没有图遍历问题，`ownerId` 选择性等价于「按租户分区」。**前置（SQL WHERE / vec0 WHERE）是显然正确的**：FTS5 MATCH 与普通 WHERE 列同表 join 即可；sqlite-vec `vec0` 支持元数据列过滤与 partition key，KNN 查询内联 `WHERE owner_id=?`。用户数据量级（单用户会话消息远小于百万级）下暴力扫描即可，无需 HNSW（[sqlite-vec README](https://github.com/asg017/sqlite-vec) 注明 vec0 虚表支持 KNN + 元数据过滤；社区实测暴力检索在中等规模表现良好）。时间/会话过滤同为 WHERE 条件，二选一皆在候选生成前生效。
- 结论：**ownerId/时间过滤在两路通道的查询内完成（索引层前置），融合与 rerank 只见已过滤候选**。这同时是隔离红线（绝不把他人会话带进融合池）。

### 1.2 中文语料的稀疏通道（本仓关键落地面）

- FTS5 默认 unicode61 tokenizer 按词边界切分，中文无空格 → 中文查询基本失效；内建 tokenizer 仅 unicode61/ascii/porter/trigram。[sqlite.org/fts5.html](https://sqlite.org/fts5.html)、[audrey.feldroy.com FTS5 tokenizer 笔记](https://audrey.feldroy.com/articles/2025-01-13-SQLite-FTS5-Tokenizers-unicode61-and-ascii)
- **方案 A：trigram**（官方支持）。每连续 3 字符为一个 token，天然支持 CJK 子串匹配与 `LIKE/GLOB` 索引优化。硬限制：**<3 unicode 字符的查询永不命中**（两字中文查询如「登录」需降级 LIKE 全表扫或拼接上下文）；索引体积显著膨胀（官方数据点：1636MiB 语料 detail=full 743MiB / column 340MiB / none 134MiB，trigram 表可用 `detail=column|none` 缩容）。[sqlite.org/fts5.html](https://sqlite.org/fts5.html)
- **方案 B：写入期外置分词**（jieba 类 → 空格分隔影子列 + unicode61）。查询词表可控、支持 2 字词、索引小；代价是写入路径要跑分词器（Node 侧 `@node-rs/jieba` 等原生绑定），且分词质量影响召回。社区实践（自定义 tokenizer/ICU）均属此类思路的变体：[GRDB.swift issue #413（中文 FTS5 tokenizer 讨论）](https://github.com/groue/GRDB.swift/issues/413)、[FTS5 ICU tokenizer](https://www.reddit.com/r/sqlite/comments/1nkaqiq/introducing_fts5_icu_tokenizer_for_better)。注意 better-sqlite3 无法注册自定义 FTS5 tokenizer（C 级扩展点），故 Node 栈只能走影子列而非真自定义 tokenizer。
- **存储工程点**：trigram 索引膨胀的对策除 `detail=column|none` 外，还有 FTS5 的 external-content / contentless 表形态（索引不重复存正文，回捞走源表）——对「正文已在 messages 表」的本仓是天然匹配，能抵掉大部分 trigram 体积代价；代价是 contentless 表限制查询形态（仅全文查询），需要与 ownerId 过滤的 join 形态核对（external-content 无此限制）。[sqlite.org/fts5.html](https://sqlite.org/fts5.html)
- 推荐：**先 trigram（零依赖、子串友好、中文标题/专名匹配好）**，若两字短查询占比高再补影子列分词或 LIKE 兜底；混合「trigram + 分词影子列」双列亦可（FTS5 多列并存，查询层合并）。

**索引形态草图（决策相关部分，示意非最终 DDL）**：

```sql
-- 稀疏通道：trigram FTS5 表；隔离/时间过滤列用 UNINDEXED 携带，查询时 WHERE join
CREATE VIRTUAL TABLE msg_fts USING fts5(
  text,                       -- trigram 索引内容
  tokenize = 'trigram detail column',   -- detail column 缩索引（官方 1636MiB 语料 743→340MiB）
  owner_id UNINDEXED, session_id UNINDEXED, occurred_at UNINDEXED, msg_block_id UNINDEXED
);
-- 稠密通道：sqlite-vec vec0 虚表；partition key 或元数据列做租户前置过滤
CREATE VIRTUAL TABLE msg_vec USING vec0(
  embedding float[1024],
  owner_id integer partition key,     -- partition key：租户隔离在检索图内前置
  session_id integer, occurred_at integer,
  auxillary msg_block_id text
);
-- 查询（两路各自）：
--   稀疏：SELECT ... FROM msg_fts WHERE msg_fts MATCH ? AND owner_id = ? AND occurred_at >= ?
--   稠密：SELECT ... FROM msg_vec WHERE owner_id = ? AND embedding MATCH :qvec AND k = 50
```

---

## 2. 融合：RRF vs 加权 vs 学习型

### 2.1 方法对比

| 方法 | 代表实现 | 优点 | 缺点 |
|---|---|---|---|
| RRF（倒数排名融合） | Elastic `rrf`（`rank_constant` 默认 60）、Azure AI Search 内建、Qdrant `Fusion.RRF`、Weaviate `rankedFusion` | 免调参、免分数归一化、对异构分数尺度免疫 | 丢弃分数幅度信息；对单通道头部优势不敏感 |
| 加权/凸组合（convex combination） | Weaviate `relativeScoreFusion`（min-max 归一，v1.24 起默认）+ `alpha` 权重；Qdrant DBSF（μ±3σ 重标定） | 保留分数差距；可用 alpha 表达「更信稠密」 | 需归一化方案选型与超参调优；分数分布漂移（换 embedding 模型）即失效 |
| 学习型融合（LTR/TRF） | Vespa global-phase + XGBoost/LTR；TRF（arXiv 2508.01405） | 上限最高 | 需训练数据 + 标注 + 训练/服务设施；本约束（无训练管线、无额外服务）**不可行** |

### 2.2 证据

- RRF 出处：Cormack, Clarke, Büttcher, SIGIR 2009，`RRF(d)=Σ 1/(k+rank_i(d))`；**k=60 是 TREC 试点期固定值，后续验证未再改动，且 k∈[30,100] 结果平坦（不敏感）**——这就是「k=60 的来历」，直接消解超参敏感顾虑。[DOI 10.1145/1571941.1572114](https://dl.acm.org/doi/10.1145/1571941.1572114)（论文），[Elastic RRF 参考（rank_constant=60）](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/reciprocal-rank-fusion)
- 分数尺度问题（为何不直接加权 raw score）：dense cosine 与 BM25 无界分数不同尺度，固定权重无法跨查询稳定平衡——Qdrant 文档原话级论证；其内部 RRF 默认 k=2（zero-based rank），与经典 60 不同，**提醒实现时显式钉死 k 而非抄默认**。[qdrant.tech/documentation/search-tuning/hybrid-search](https://qdrant.tech/documentation/search-tuning/hybrid-search/)
- 加权何时优于 RRF：Weaviate 的相对分数融合（min-max）默认化说明「当两路分数分布可用自身 min/max 稳定归一时，保幅度的加权更优」；但顶部分数聚集或列表短时不稳定。[docs.weaviate.io/weaviate/search/hybrid](https://docs.weaviate.io/weaviate/search/hybrid)、[weaviate.io/blog/hybrid-search-fusion-algorithms](https://weaviate.io/blog/hybrid-search-fusion-algorithms)。Azure AI Search 用 RRF 为骨架、`vectorQueries[].weight` 做通道间粗权重——「RRF 打底 + 单一标量权重」是工业折中。[learn.microsoft.com/azure/search/hybrid-search-overview](https://learn.microsoft.com/azure/search/hybrid-search-overview)
- 学习型融合能更好但代价高：TRF（arXiv 2508.01405）显示 tensor 重排融合稳定优于简单 RRF；Vespa 把 LTR 放 global-phase（[docs.vespa.ai/en/ranking/phased-ranking.html](https://docs.vespa.ai/en/ranking/phased-ranking.html)）。均需标注数据与模型服务，超出本仓约束。
- 反例与清醒剂：从业者报告 BGE-M3 + pgvector 加 RRF 后提升甚微——融合收益依赖语料/查询分布，需自建评测集验证而非默认收益。（[reddit r/Rag 实践报告](https://www.reddit.com/r/Rag/comments/1sjpl95/hybrid_search_bm25_vectors_rrf_barely_improved)，二手）

### 2.3 本仓落地面

**RRF（k=60，1-based rank，两路，depth=50）**。理由：零训练、零归一化、k 不敏感、与「rerank API 兜底」天然解耦（rerank 只消费融合后候选 id 列表）。加权/DBSF 留作评测集证明 RRF 不足时的升级项。 Vespa/Elastic 的多阶段框架价值在本仓由「融合分截断 → API rerank」等效实现。

**切换到加权融合的触发条件**（须先有评测集）：若评测显示「稠密路头部显著优于稀疏路头部」的场景占比高（会话检索常见：口语化查询 BM25 几乎无命中而 dense 命中好），RRF 的 1/rank 会稀释 dense 头部优势——此时换 convex combination `score = α·dense_norm + (1-α)·bm25_norm`（min-max 归一，α 起步 0.6，Weaviate 默认 α=0.5 可作参照）。反方向（专名查询多）则调低 α。该调参只在评测集存在时做，否则维持 RRF 默认——k∈[30,100] 平坦（Cormack 2009）是 RRF 相对加权的核心工程优势。

**融合 depth=50 的依据**：Qdrant 官方课程示例为 prefetch 20+20 → fuse → 10（[qdrant.tech/course](https://qdrant.tech/course/essentials/day-3/hybrid-search/)）；本仓取 50+50 是为 rerank 层留 24 候选的冗余（单路头部未命中时另一路仍有补给），进程内排序零成本。

---

## 3. 分层排序：粗排 → 精排 → rerank

### 3.1 各层职责与候选数（工业配置佐证）

- **Anthropic**（一手）：retrieve top-150 → Cohere rerank → top-20 注入；明确「rerank 更多 chunk 换效果 vs 更少换延迟」的权衡表述。[anthropic.com/engineering/contextual-retrieval](https://www.anthropic.com/engineering/contextual-retrieval)
- **ZeroEntropy**（rerank 基础设施厂商，2025 指南）：**50–75 候选 rerank 在多数应用最优 NDCG@10；>100 候选质量收益平台化而延迟成本继续涨**。[zeroentropy.dev/articles/ultimate-guide-to-choosing-the-best-reranking-model-in-2025](https://zeroentropy.dev/articles/ultimate-guide-to-choosing-the-best-reranking-model-in-2025)
- **Vespa**（一手，two-phase 延迟工程）：second-phase rerank-count 200→50 **砍 75% 计算**；first-phase 保持与 second-phase 相关性足够高的便宜函数是系统设计核心。[docs.vespa.ai/en/ranking/phased-ranking.html](https://docs.vespa.ai/en/ranking/phased-ranking.html)、[learn.vespa.ai/reranking-ltr/multiphase-ranking](https://learn.vespa.ai/reranking-ltr/multiphase-ranking)
- **Qdrant 课程示例**（一手）：prefetch 各 20 → fusion → top 10，即「粗排 2×20 → 精排 10」的小候选配置对本仓更有参照性。[qdrant.tech/course/essentials/day-3/hybrid-search](https://qdrant.tech/course/essentials/day-3/hybrid-search/)

### 3.2 reranker 选型（本约束：无本地 GPU，只能 API 或不用）

| Reranker | 类型/规模 | 上下文 | 中文/多语 | 接入面 | 备注 |
|---|---|---|---|---|---|
| Cohere Rerank 3.5 | API | 4096 tok/doc | 100+ 语言 | `top_n` 参数 | 官方称对系统延迟影响可忽略（前提是 API 就近）[cohere.com/blog/rerank-3pt5](https://cohere.com/blog/rerank-3pt5)、[docs.cohere.com/reference/rerank](https://docs.cohere.com/reference/rerank) |
| Voyage rerank-2.5 / -lite | API | 32k | 多语（31 语评测） | `top_k` | 官方称 lite 为延迟优化档；Azure 目录称 +7.16% over Cohere 3.5（93 数据集）[docs.voyageai.com/docs/reranker](https://docs.voyageai.com/docs/reranker)、[blog.voyageai.com/2025/08/11/rerank-2-5](https://blog.voyageai.com/2025/08/11/rerank-2-5) |
| Jina reranker v2 / v3 | API/开权重 | 8k（v3 8192） | 多语 | API | v2 主打 agentic RAG 低延迟多语 [jina.ai/news/jina-reranker-v2...](https://jina.ai/news/jina-reranker-v2-for-agentic-rag-ultra-fast-multilingual-function-calling-and-code-search)；v3 0.6B [arXiv 2509.25085](https://arxiv.org/html/2509.25085v1) |
| bge-reranker-v2-m3 | 开权重 cross-encoder ~568M | 8192 | 中英俱佳 | 需自托管或经托管 API | 本仓无 GPU → 仅当网关目录提供时可用 [huggingface.co/BAAI/bge-reranker-v2-m3](https://huggingface.co/BAAI/bge-reranker-v2-m3) |
| Qwen3-Reranker 0.6B/4B/8B | 开权重 | 32k | 100+ 语，MTEB 系强 | 需自托管或经托管 API | 同上 [arXiv 2506.05176](https://arxiv.org/abs/2506.05176) |
| RankGPT（LLM listwise） | LLM 调用 | — | — | 复用 chat 端点 | top-100、窗口 20 步 10；每窗口一次 LLM 调用，热路径延迟不可承受，仅适合异步 [arXiv 2304.09542](https://arxiv.org/abs/2304.09542) |

**rerank API 调用面细节（省延迟/流量的工程点）**：Cohere v2 用 `top_n` 只回前 N 条、`return_documents: false` 免回传原文（我们只要序）、`max_chunks_per_doc` 控长块切分；Voyage 用 `top_k`。候选以 `msg_block_id` 传入原文、回来只重排 id 列表——payload 最小化，与注入层（父子回捞在本地做）解耦。[docs.cohere.com/reference/rerank](https://docs.cohere.com/reference/rerank)、[docs.voyageai.com/reference/reranker-api](https://docs.voyageai.com/reference/reranker-api)

### 3.3 延迟实测数据（一手基准）

- **Cohere Rerank 3.5 请求级延迟（OCI 官方基准页，rerank 是单响应所以 TTFT≈全延迟）**：24 docs × 128 tok = **0.13s**；48 × 128 = 0.16s；24 × 512 = **0.20s**；96 × 512 = 0.54s；2048 tok 长文档显著恶化（48×2048=2.01s）。→ **短 chunk（会话消息块通常 ≤256 tok）+ ≤24 候选时 rerank API 约 110–200ms**。[docs.oracle.com/en-us/iaas/Content/generative-ai/benchmark-cohere-rerank-3-5.htm](https://docs.oracle.com/en-us/iaas/Content/generative-ai/benchmark-cohere-rerank-3-5.htm)
- ColBERT/late-interaction（本地多向量路线的延迟参照）：PLAID k=1000 在 GPU ~100ms、CPU 数百 ms（LoTTE 单线程 >500ms）；DESSERT 22.7–32.3ms。即便延迟可接受，**per-token 向量的存储量在 SQLite 中不可行**（每消息 token 数×向量维度），直接排除。[PLAID arXiv 2205.09707](https://arxiv.org/abs/2205.09707)、[DESSERT arXiv 2210.15748](https://arxiv.org/pdf/2210.15748)
- 稀疏+稠密粗排在 SQLite 内：FTS5 完全匹配 token 查询是「单次查找」级（[sqlite.org/fts5.html](https://sqlite.org/fts5.html)）；sqlite-vec 暴力 KNN 在十万级以下向量毫秒级（[github.com/asg017/sqlite-vec](https://github.com/asg017/sqlite-vec)）。单用户语料（数万消息块）内 **<10ms 量级**，非瓶颈。

### 3.4 embedding API 延迟（预算的最大不确定项）

- Zep 实测（一手博客）：OpenAI embedding API 从 AWS p95 ≈ **600ms**。[getzep.com/blog/text-embedding-latency-a-semi-scientific-look](https://www.getzep.com/blog/text-embedding-latency-a-semi-scientific-look/)
- Milvus 官方 20+ embedding API 基准（一手博客）：典型调用「数百 ms 到数秒」；**网络地理是主导因素**（跨区 3–4×），批量 1→10 延迟 2–5×；结论是必须在自身环境重测 + 缓存 + 重试/熔断。[milvus.io/blog/we-benchmarked-20-embedding-apis-with-milvus...](https://milvus.io/blog/we-benchmarked-20-embedding-apis-with-milvus-7-insights-that-will-surprise-you.md)
- 社区实测：单短句 565–1332ms（均值 832ms）无缓存直连（[OpenAI 论坛](https://community.openai.com/t/embeddings-api-extremely-slow/1135044)，二手）；优化管线内 9–15ms（[agentset.ai](https://agentset.ai/embeddings/openai-text-embedding-3-small)，二手，含长连接复用）。
- **预算结论**：单查询 1 次 embedding 调用，p50 按 **100–300ms** 计、p95 按 **≤600ms** 计；这是全链路最大单项，须客户端 keep-alive 连接池 + 300ms 软超时 + 超时降级为纯稀疏通道。
- **工程侧写**：Milvus 基准明确「地理是主导因素」——本仓网关与控制面同区部署时应显著优于跨区实测值；批量对单查询无意义（我们每消息只嵌 1 条查询），批量优化留给索引期写入路径（batch 1→10 延迟涨 2–5×但吞吐换写入效率，[milvus.io 基准](https://milvus.io/blog/we-benchmarked-20-embedding-apis-with-milvus-7-insights-that-will-surprise-you.md)）。

### 3.5 候选数推导（为何 50 / 24 / 8）

- **粗排 top-50/路**：为融合后 24 候选提供冗余（§2.3）；Vespa 的教训是 second-phase 候选数是延迟主杠杆（200→50 砍 75% 计算），故宁可粗排宽、精排窄。
- **rerank 24 候选**：ZeroEntropy 最优区间 50–75 与 Anthropic 的 150 都是为「文档级大库」设计且延迟预算宽（Anthropic 场景无 800ms 门槛）；本仓受 §3.3 Oracle 实测约束——24×512tok ≈ 0.20s、24×128tok ≈ 0.13s，正落在预算缝里；>48 候选或长 chunk 会把 rerank 单层推过 300ms。会话消息块天然短（见 §5 切分参数），24 是「效果区间下沿 × 延迟实测」的交点。
- **final top-8 注入**：Anthropic 注入 20（其上下文预算大）；本仓注入的是完整轮次窗口（父子回捞放大体积，§5），按「8 命中块 × 平均 3–5 条消息窗口」计约 24–40 条消息 ≈ 3–6k tok，与 agent loop 现有上下文预算兼容。8 为起点，实际值应随注入 token 预算与评测校准。

---

## 4. 查询面：改写 / 多查询 / HyDE

### 4.1 证据与结论

| 技术 | 收益证据 | 成本 | 何时负收益 | 本仓判定 |
|---|---|---|---|---|
| 查询改写（多轮指代消解） | Rewrite-Retrieve-Read（arXiv 2305.14283，被引 1000+）：多轮对话 query 含指代/省略，直接检索失败率高，改写后一致提升 [arxiv.org/abs/2305.14283](https://arxiv.org/abs/2305.14283) | +1 次 LLM 调用（热路径 300ms–2s） | 单轮自包含查询 | **必要性真实但成本不可热路径承受** → 用规则化替代：把上一轮（≤2 轮）用户+assistant 消息拼接进检索 query，零 LLM 成本消化大部分指代；LLM 改写降级为可选旁路 |
| 多查询（multi-query / RAG-Fusion） | DMQR-RAG（arXiv 2411.13154）：多视角改写 + 自适应融合提升检索与生成 [arxiv.org/html/2411.13154v1](https://arxiv.org/html/2411.13154v1)；RAG-Fusion 初步结果正向 [SSRN](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=5223505) | +N 次 LLM 调用（通常 N=3–5），嵌入调用同步 ×N | 查询已明确、语料小时边际收益小 | **拒绝入热路径**；如需，异步对整段会话预生成备用查询 |
| HyDE | 原论文（arXiv 2212.10496）：零监督 dense 检索 DL19 nDCG@10 61.3 vs Contriever ~49.8 [arxiv.org/abs/2212.10496](https://arxiv.org/abs/2212.10496) | +1 次生成调用（1–3s）；幻觉漂移风险 | 查询本身已是长文档（ArguAna 型负收益）；用户词汇与语料已对齐时冗余（生产分析：[ratkonikolic.com](https://www.ratkonikolic.com/p/advanced-rag-what-you-actually-run)） | **不用**：会话消息查询短且用户词汇=语料词汇（都是自己写的），恰处负收益区；延迟超预算 |

### 4.2 本仓落地面

每消息无条件的检索是**短查询 + 同作者语料**场景：词汇失配弱（用户检索自己的话）、指代失配强（「那个怎么办」）。故投资方向是**上下文拼接（规则）而非生成式改写**。若后续评测显示指代问题严重，升级路径是「小模型 + 严格 token 上限的改写」异步预计算下一轮查询候选，或接受同步 +150–400ms 的显式权衡。

**规则化拼接规格（建议初版）**：

- 检索 query = 当前用户消息全文（截断 ≤512 tok）+ 前一条 assistant 回复的首句/摘要（≤64 tok）+ 更早一轮用户消息（≤64 tok，仅当当前消息 <30 字时追加——短消息指代概率高）。
- FTS5 查询与 embedding 输入用同一拼接串；FTS5 侧可只用当前消息（避免长串 trigram 误召回），embedding 侧用全拼接串——两通道查询面允许不同，这是双通道架构的自由度。
- 硬性不为指代消解上 LLM 热路径调用（RRR 论文证明收益真实，但每消息 +1 次 LLM 调用与 ≤800ms 预算冲突；异步旁路见 §6.2.3）。

---

## 5. 多表示索引：双塔 Q&A / 父子块 / 多向量

- **父-子块（small-to-big）**：LlamaIndex `HierarchicalNodeParser` + `AutoMergingRetriever` / `RecursiveRetriever` 是标准实现——小块（精准命中）做索引、大块（上下文完整）做注入；会话场景对应「消息块命中 → 回捞其所属轮次窗口/整段会话」。[developers.llamaindex.ai/python/framework/integrations/retrievers/recursive_retriever_nodes](https://developers.llamaindex.ai/python/framework/integrations/retrievers/recursive_retriever_nodes/)；LangChain 有等价 ParentDocumentRetriever 概念（[zeroentropy.dev 概念页](https://zeroentropy.dev/concepts/parent-document-retrieval/)，二手）。
  - 本仓落地：**低成本高收益，推荐**。索引单元 = 单条消息或 ≤N 条消息窗口；注入单元 = 命中消息所在「轮次组」（前后各 k 条消息），仅是 id → 父块指针查询，SQLite 一条 join。
- **问题/答案双表示（"questions this chunk answers"）**：索引期为每 chunk 用 LLM 生成其能回答的问题并嵌入，查询与「问题空间」匹配。收益在问答语料上有佐证（LlamaIndex/LangChain 社区实践，[galileo.ai LlamaIndex 指南](https://galileo.ai/blog/llamaindex-complete-guide-rag-data-workflows-llms)，二手）；成本全部在索引期（每块一次 LLM），**查询期零成本**。
  - 本仓落地：**可选异步增强**——会话空闲时后台为消息块生成 1–2 个「该消息回答了什么」问题入同库另一列/表；适合「查问题而非查原文」的召回。非首版必需。
- **Anthropic contextual retrieval（chunk 上下文标头）**：给每 chunk 前置 LLM 生成的位置上下文描述再索引；成本 $1.02/M doc tokens（一次性，配 prompt caching）。对会话数据，「上下文=所属会话主题摘要」，价值同向。[anthropic.com/engineering/contextual-retrieval](https://www.anthropic.com/engineering/contextual-retrieval)
  - 本仓落地：变体可用——索引期把「会话标题 + 前文摘要」拼进消息块的 embedding 输入与 FTS5 文本（写入期一次性成本，可复用已有 chat 端点异步做）。
- **多向量（ColBERT per-token）**：效果与延迟数据见 §3.3；存储形态（每 token 一向量）与 SQLite 单文件形态冲突，**排除**。BGE-M3 的三合一（dense+sparse+multi-vector，[arXiv 2402.03216](https://arxiv.org/abs/2402.03216)）中，**dense 通道可直接复用**（网关出向量），其「学习型稀疏权重」无法映射进 FTS5（非词项统计），放弃 sparse 复用、以 BM25 替代。
- **中文 embedding 选型（网关目录为准）**：BGE-M3——100+ 语言、8192 token、MIRACL 多语检索 SOTA（[arXiv 2402.03216](https://arxiv.org/abs/2402.03216)、[huggingface.co/BAAI/bge-m3](https://huggingface.co/BAAI/bge-m3)）；Qwen3-Embedding——0.6B/4B/8B 三档，8B 居 MTEB Multilingual 第一（70.58，2025-06），中文强（[arXiv 2506.05176](https://arxiv.org/abs/2506.05176)、[qwenlm.github.io/blog/qwen3-embedding](https://qwenlm.github.io/blog/qwen3-embedding)）。两者均为国内网关（OpenAI 兼容）常备目录项，与「embedding 走既有网关」约束兼容。

**多表示技术成本-收益一览（本仓视角）**：

| 技术 | 索引期成本 | 查询期成本 | 预期收益 | 本仓判定 |
|---|---|---|---|---|
| 父子块（small-to-big） | 零（纯结构关系） | 一次 join 回捞 | 命中精度 × 上下文完整性兼得 | **P0/P1 即做** |
| 上下文标头（contextual header 变体） | 每块 1 次 LLM（Anthropic 实测 $1.02/M doc tokens 量级）；会话场景可用「会话标题+前文摘要」规则生成，多数块零 LLM | 零 | Anthropic -35% 失败率（其含 LLM 标头）；规则版收益待测 | P3 规则版先行 |
| 问题生成（"questions this chunk answers"） | 每块 1 次 LLM（异步） | 零 | 查问题类查询收益（社区佐证，无强一手基准） | P3 可选，评测驱动 |
| ColBERT 多向量 | 存储 ×~100（per-token） | CPU 数百 ms | 精排上限 | 排除（§3.3） |

---

## 6. 对话/agent 轨迹数据的专门实践（memory 产品检索机制）

### 6.1 各产品机制与证据

| 系统 | 检索/分层机制 | 关键一手证据 |
|---|---|---|
| MemGPT/Letta | 两层记忆：main context（工作上下文 + 滚动摘要）与 external context（**recall storage = 逐字会话库** + archival storage = 文档库）；LLM 自调度 `recall_storage.search()`。DMR 基准 92.5% vs 基线 32.1% | [arXiv 2310.08560](https://arxiv.org/abs/2310.08560) |
| Mem0 | 两阶段管线：extraction（LLM 抽取记忆条目）+ update（合并/冲突消解）；检索是向量+可选图（Mem0g）。全链路 p95 **1.44s**，比全上下文基线省 91% 延迟、>90% token | [arXiv 2504.19413](https://arxiv.org/abs/2504.19413) |
| Zep/Graphiti | 时序知识图谱（episode→entity→fact，带失效时间）；DMR 准确率 +18.5%，响应延迟比全上下文低约 90% | [arXiv 2501.13956](https://arxiv.org/abs/2501.13956)、[github.com/getzep/graphiti](https://github.com/getzep/graphiti) |
| LangMem/LangGraph | 「hot path 工具」（agent 会话中自调 manage/search memory）vs「background 整合」（离线抽取合并）双模式；namespace 隔离 + 向量检索 | [langchain-ai.github.io/langmem](https://langchain-ai.github.io/langmem/)、[hot_path_quickstart](https://langchain-ai.github.io/langmem/hot_path_quickstart) |
| ChatGPT memory | 双机制：saved memories（显式事实清单）+ reference chat history（按需检索旧会话） | [help.openai.com/en/articles/8590148](https://help.openai.com/en/articles/8590148-memory-in-chatgpt)；机制深挖（二手）：[embracethered.com](https://embracethered.com/blog/posts/2025/chatgpt-how-does-chat-history-memory-preferences-work) |
| Anthropic memory tool | 文件式 `/memories` 目录、client-side 执行；配套 context engineering 论述「context rot」→ 建议 note-taking + just-in-time 检索；Anthropic 报告 memory+context editing 组合在内部长任务评测提升 ~39% | [platform.claude.com/docs...memory-tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)、[anthropic.com/engineering/effective-context-engineering-for-ai-agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) |

**共性机制归纳**：六家实现殊途同归于三点——(a) 检索都是有条件/按需触发（工具化或注入前查询），无一例外做了租户/用户命名空间隔离；(b) 都维护「压缩表示（摘要/事实/图谱）」与「原始轨迹」两种形态，且原始轨迹可回查；(c) 写入侧（抽取/整合）全部与读取侧（检索）解耦。本报告的两层设计（§6.2 表）正是把 (b)(c) 内嵌进 SQLite、把 (a) 换成本系统特有的「每消息无条件触发」形态——这是与上述所有产品的最大差异点，也是延迟预算存在的原因。

### 6.2 对本系统的四个可迁移结论

1. **「逐字消息层」与「抽取记忆层」是两个互补层，且逐字层不可省**。所有主力产品都保留逐字会话检索（MemGPT recall storage、ChatGPT reference chat history、Anthropic just-in-time retrieval）。2026 年对照实验（arXiv 2601.00821）更直接：对话 RAG 中**逐字 chunk 管线 43.9% 全面优于抽取 artifact 管线；时间类问题逐字 50.2% vs artifact 31.2%；去掉时间戳元数据准确率掉到 28.0%**——「先压缩再检索」损失保真度，时间锚元数据是硬依赖。[arxiv.org/html/2601.00821v3](https://arxiv.org/html/2601.00821v3)
   → 本仓：主层 = 逐字消息块（含 sessionId/timestamp/sender 元数据列），辅层 = 异步抽取的记忆条目（Mem0/LangMem 式，空闲期跑，不挡热路径）。
2. **切分策略：按轮次窗口而非单条，附元数据**。工业实践（会议/客服转写）共识：单 turn 太小缺上下文 → 按说话人轮次分窗（滑动窗口/话题断点），每块带 speaker/时间戳/会话 id 元数据（[IBM chunking 指南](https://developer.ibm.com/articles/awb-enhancing-rag-performance-chunking-strategies)、Dell「Chunk Twice, Retrieve Once」（转引自 [acta.ai 类实践综述]，二手））。
   → 本仓：消息块 = 单条长消息（>阈值则按句子截断）或连续短消息小窗口（如同方向连续 ≤5 条 / ≤512 tok），重叠 1 条；父子回捞见 §5。

**会话切分参数建议（决策相关）**：

| 参数 | 建议值 | 依据 |
|---|---|---|
| 索引块上限 | ~512 tok | rerank 延迟实测拐点（24×512=0.20s vs 24×1024=0.45s，§3.3）；块越短 rerank 越便宜 |
| 短消息合并窗口 | 同向连续 ≤5 条或 ≤512 tok | 单 turn 太小缺上下文（IBM/转写实践，§6.2.2） |
| 块间重叠 | 1 条消息 | 滑窗保持跨块连续性（Dell/转写实践） |
| 父块（注入单元） | 命中块所在轮次组：前后各 k 条消息（k=3–5） | small-to-big：小块精准命中、大块保上下文（LlamaIndex recursive retriever） |
| 元数据列 | sessionId / occurred_at / sender / role | 时间锚是会话检索硬依赖（去时间戳 28.0% vs 50.2%，arXiv 2601.00821） |
| 跨会话边界 | 不跨（块永不混合两个 sessionId） | 隔离与父子回捞的完整性 |
3. **热路径与冷路径分离是 memory 产品的通用架构**（LangMem 显式命名 hot path / background；Mem0 抽取是消息后处理）。每消息同步链路里只做「检索」，不做「抽取/摘要/图谱写入」。Mem0 的 extraction/update 两阶段（每消息 LLM 抽取 + 与既有记忆合并消解）意味着其记忆写入本身就是重操作——其论文里 1.44s p95 是「含记忆写入的完整回路」，若把抽取塞进本仓每消息同步链路必然破预算，佐证分离的必要性（[arXiv 2504.19413](https://arxiv.org/abs/2504.19413)）。
   → 本仓：检索同步（本报告管线），记忆抽取/会话摘要/问题生成全部异步（BullMQ 已有队列基建）。
4. **时序是会话检索的一等公民**：Zep 专门建时序图、LoCoMo 时间类问题最依赖时间戳。ownerId 之外，`timestamp` 应作为可过滤元数据与排序信号（新近度加分可在融合后轻做，或仅作为 tie-breaker）。

**两层检索对象的具体形态（本仓 schema 建议）**：

| 层 | 内容 | 索引 | 写入时机 | 检索角色 |
|---|---|---|---|---|
| 主层：逐字消息块 | 原文（截断至 512 tok）+ 元数据 | FTS5 trigram + 向量 | 消息落库后同步/准同步 | 本报告管线的检索对象；保真、时间锚、可引用回原消息 |
| 辅层：记忆条目 | 异步抽取的原子事实（「用户偏好 X」「项目决定 Y」），带来源消息指针 | 同库另一对 FTS5/vec 表（namespace 隔离仿 LangMem） | BullMQ 空闲任务（Mem0 extraction/update 两阶段式） | 同管线第二检索面（RRF 加入第三路或单独 top-k 合并）；供「跨会话聚合事实」类查询 |
| 取舍红线 | 辅层条目必须可溯源（source msg_block_id）；逐字层永不退役 | — | — | LoCoMo 证据：压缩层单独用会输给逐字层（§6.2.1），故辅层只做增益不做替代 |

---

## 7. 总对比表（候选架构 × 硬约束）

| 架构形态 | SQLite-only | ≤800ms p50 热路径 | 中文 | 隔离过滤 | 综合判定 |
|---|---|---|---|---|---|
| **A：FTS5(trigram) + sqlite-vec + RRF + API rerank（本报告推荐）** | ✅ 均为进程内 | ✅ 160–560ms（API 尾延迟设超时降级） | ✅ trigram + bge-m3/Qwen3 系 | ✅ 双通道 WHERE 前置 | **推荐** |
| B：纯 FTS5 稀疏（无稠密） | ✅ | ✅ <20ms | ⚠️ trigram 可用但语义召回缺失 | ✅ | 最低配 fallback；与 Anthropic/Blended RAG 证据相悖（dense 贡献 35% 失败率降幅） |
| C：纯稠密（无 FTS5） | ✅ | ✅ | ✅ | ✅ | 专名/精确串召回缺失；放弃 |
| D：A + LLM 查询改写/多查询（热路径） | ✅ | ❌ +300ms–2s/查询 | ✅ | ✅ | 降级为异步旁路后并入 A |
| E：ColBERT/BGE-M3 多向量 | ⚠️ 存储形态不可行 | ⚠️ CPU 500ms+/k=1000 | ✅ | ⚠️ | 排除（PLAID/DESSERT 数据 + SQLite 存储冲突） |
| F：Zep/Mem0 式独立记忆服务（图谱/托管） | ❌ 新增服务 | ⚠️ | ✅ | ✅ | 排除服务形态；**借鉴其分层与异步抽取**（§6.2） |
| G：SPLADE 学习型稀疏 | ❌ 索引期需编码模型 | ⚠️ | ⚠️ | ✅ | 排除；BM25 已够 |
| H：A + 分词影子列（§1.2 方案 B） | ✅ | ✅ | ✅✅（2 字词可查） | ✅ | A 的中文查询升级变体，评测驱动切换（§9.3） |
| I：A + 异步记忆条目层（§6.2 全形态） | ✅（同库内嵌） | ✅（辅层不挡热路径） | ✅ | ✅ | A 的完整目标形态（P3），主层不变 |

---

## 8. 推荐结论（对照硬约束逐条打分）

**推荐架构 A**（TL;DR 表全量）：FTS5 trigram 稀疏 + sqlite-vec 稠密（网关 embedding）+ ownerId/时间 WHERE 前置 + RRF(k=60) + rerank API（top-24→top-8，可超时降级）+ 规则化上下文拼接查询 + 逐字消息块主层/异步记忆条目辅层 + 父子回捞注入。

1. **单进程 Express+SQLite**：FTS5 为 SQLite 内建（[sqlite.org/fts5.html](https://sqlite.org/fts5.html)）；sqlite-vec 为纯 C 单文件可加载扩展、零依赖、随 SQLite 可跑（[github.com/asg017/sqlite-vec](https://github.com/asg017/sqlite-vec)）；embedding/rerank 走既有网关（仓库已验证 embedding 可行）。**满分合规，零新服务**。
2. **每消息同步链路 ≤~800ms p50**：组成 = 规则拼接(0) + embedding API(100–300) + FTS5/vec(<10) + RRF(<1) + rerank API(110–250) ≈ **160–560ms**；每层设超时，embedding 超时降级纯稀疏、rerank 超时直接用 RRF 序——p95 尾部有显式降级路径而非超支。延迟数据源：Oracle rerank 基准（§3.3）、Zep/Milvus embedding 实测（§3.4）、FTS5/sqlite-vec 进程内查询特性（§3.3）。
3. **中文主导语料**：trigram 官方支持 CJK 子串（<3 字限制有 LIKE 兜底与分词影子列备选）；稠密通道 bge-m3（MIRACL SOTA）/ Qwen3-Embedding（MTEB Multilingual #1）皆中文强且为国内网关常见目录；rerank 中 bge-reranker-v2-m3「中英俱佳」（HF model card）。
4. **隔离硬需求**：ownerId 作为两通道查询内 WHERE 条件（索引层前置），符合 Qdrant「过滤参与检索」工程共识且天然满足租户隔离；时间/会话过滤同路径。

**证据支持的偏离说明**：① 若网关无 rerank API，A 的降级形态（RRF 精排、无 cross-encoder）仍优于纯单通道——Anthropic 数据中 embeddings+BM25 的 49% 降幅不依赖 rerank；② 若评测发现两字中文查询占比高，FTS5 切换/叠加分词影子列（§1.2 方案 B），架构其余不变；③ LLM 查询改写如有必要只走异步，与 Mem0/LangMem 的热/冷路径分离一致。

**评分表（推荐形态 A vs 降级形态 A'，对照三条硬约束 + 隔离）**：

| 维度 | A（rerank API 可用） | A'（无 rerank API，RRF 精排） | 依据 |
|---|---|---|---|
| 约束①：SQLite-only，零新服务 | 5/5 | 5/5 | FTS5 内建 + sqlite-vec 进程内扩展 + 网关 API（§1.2、§10 仓库内引用） |
| 约束②：≤~800ms p50 | 4/5（p50 达标，p95 需降级开关兜底） | 5/5（<30ms 极充裕） | §0 预算表、§3.3/§3.4 实测 |
| 约束③：中文语料 | 4/5（trigram 3 字限制 + 网关模型目录待确认） | 3/5（纯稀疏丢语义召回） | §1.2、§5 中文模型证据 |
| 隔离硬需求 | 5/5 | 5/5 | 双通道 WHERE 前置（§1.1） |
| 检索质量上限（相对） | 最高（混合 49% 失败率降幅 + rerank 至 67%，Anthropic） | 中高（49% 降幅档，无精排） | anthropic.com contextual retrieval |
| 实现复杂度 | 中（两索引 + 两 API 客户端 + 融合 + 降级开关） | 低-中 | — |

**一句话结论**：在「单进程 SQLite、每消息同步检索、中文语料、租户隔离」四重约束下，证据一致指向的最稳健形状是——**FTS5(trigram) + sqlite-vec 双路前置过滤召回 + RRF(k=60) 融合 + 可降级的 API rerank（top-24→top-8）**；LLM 生成式查询增强（改写/多查询/HyDE）一律移出热路径；会话数据以「逐字消息块 + 时间锚元数据」为主检索层、异步抽取记忆条目为辅层，父子回捞补上下文。所有单层选择均有 2024–2026 一手基准或官方工程数据背书，整体 p50 ≈ 160–560ms，留有降级开关兜住 API 尾延迟。

**评测口径建议（上线前最小验证集）**：≥50 条自标注查询，覆盖四类——专名/精确串、同义改写、时间型、短指代（与 §1.1 查询类型表一一对应）；指标 recall@8 / MRR；对照组 = 纯稠密、纯稀疏、混合无 rerank、混合+rerank 四臂，对应 §7 的 A'/C/B/A 形态。这直接服务 §9.4（融合增益验证）与 §9.1（rerank 缺失时的损失量化）。

---

## 9. 残余开放问题

1. **网关 rerank 目录未确认**：`LLM_API_KEY` 网关是否提供 rerank 端点及中文 rerank 模型（bge-reranker-v2-m3 / Qwen3-Reranker）？需连通性 PoC；否则长期落在降级形态，需自建小评测判断损失。
2. **网关 embedding 模型目录与维度**：bge-m3（1024 维）vs Qwen3 系（含 Matryoshka 降维）可用性、批量延迟 p95 实测——Milvus 基准明确要求「在自身环境重测」（§3.4）。
3. **trigram vs 分词影子列的实测取舍**：取决于真实会话查询长度分布（2 字词占比）与索引体积预算；需用脱敏会话样本测 recall/延迟/体积三角。
4. **融合收益验证**：RRF 相对纯稠密的增益在本语料未知（有 RRF 增益甚微的反例报告，§2.2）；建议建 50–100 条自标注查询评测集（含时间类、指代类、专名类三组）再定是否需要加权升级。
5. **记忆条目抽取的性价比**：Mem0 式异步抽取层在「个人历史会话」场景的增量收益（相对纯逐字检索）需 A/B；LoCoMo 对照显示 artifact 抽取管线可能反而劣于逐字（§6.2.1），抽取层的价值更可能在「跨会话聚合事实」而非「单会话内召回」。
6. **sqlite-vec 成熟度**：0.1.x 版本迭代中（release notes 自述修复长期 bug）；暴力扫描在单用户量级无虞，但需钉版本 + 契约测试。
7. **未决：p95 预算是否需要硬门**：若产品要求 p95 也 ≤800ms，embedding API 尾延迟（~600ms）+ rerank（~250ms）叠加会破线，需二选一降级策略的明确产品决策。

---

## 9.5 实施顺序建议（依赖驱动）

1. **P0**：FTS5 trigram 索引 + ownerId/时间 WHERE + 查询拼接规则 + 注入 agent loop（纯稀疏单路即可上线，零外部依赖，先建立评测集基线）。
2. **P1**：sqlite-vec 稠密路 + 网关 embedding（连通性/延迟 PoC 先行，钉住模型与维度）+ RRF 融合 → 对照 P0 评测集验证融合增益（§9.4）。
3. **P2**：rerank API 接入（若网关目录有）+ 超时降级开关 → 再跑评测定 rerank 候选数（24 起步）。
4. **P3（异步域，不挡热路径）**：记忆条目抽取层、问题生成增强（§5）、会话上下文标头（contextual chunk header 变体）。

每步都有独立可回退的降级形态（P0 本身即 P1/P2 的降级终点），与 §0 预算表的降级开关同构。

---

## 10. 参考来源清单

### 一手（论文 / 官方文档 / 官方工程博客 / 官方基准）

**论文（arXiv/ACL/ACM）**
- Blended RAG（IBM）— https://arxiv.org/abs/2404.07220 （2024）
- Anthropic contextual retrieval 底层做法 — https://www.anthropic.com/engineering/contextual-retrieval （2024-09）
- M3-Embedding（BGE-M3）— https://arxiv.org/abs/2402.03216 （ACL Findings 2024）
- Qwen3 Embedding — https://arxiv.org/abs/2506.05176 （2025-06）
- SPLADE-v3 — https://www.alphaxiv.org/abs/2403.06789 （2024）
- RRF 原始论文（Cormack et al., SIGIR 2009）— https://dl.acm.org/doi/10.1145/1571941.1572114
- HyDE — https://arxiv.org/abs/2212.10496 （ACL 2023）
- Rewrite-Retrieve-Read（查询改写）— https://arxiv.org/abs/2305.14283 （2023）
- DMQR-RAG（多查询改写消融）— https://arxiv.org/html/2411.13154v1 （2024-11）
- RankGPT — https://arxiv.org/abs/2304.09542 （EMNLP 2023）
- PLAID（late-interaction 引擎）— https://arxiv.org/abs/2205.09707 （CIKM 2022）；DESSERT — https://arxiv.org/pdf/2210.15748
- TRF（hybrid search 融合权衡）— https://arxiv.org/html/2508.01405v2 （2025）
- MemGPT — https://arxiv.org/abs/2310.08560 （2023-10）
- Mem0 — https://arxiv.org/abs/2504.19413 （2025-04）
- Zep（Graphiti）— https://arxiv.org/abs/2501.13956 （2025-01）
- Verbatim Chunks Beat Extracted Artifacts — https://arxiv.org/html/2601.00821v3 （2026）
- Jina reranker v3 — https://arxiv.org/html/2509.25085v1 （2025）
- bge-reranker-v2 系评测论文 — https://arxiv.org/pdf/2409.15700

**官方文档 / 官方基准 / 官方博客**
- SQLite FTS5（trigram/性能/索引体积）— https://sqlite.org/fts5.html
- sqlite-vec — https://github.com/asg017/sqlite-vec ；发布公告 https://alexgarcia.xyz/blog/2024/sqlite-vec-stable-release/index.html
- Elastic RRF 参考（rank_constant=60）— https://www.elastic.co/docs/reference/elasticsearch/rest-apis/reciprocal-rank-fusion ；Elastic hybrid search 概览 — https://www.elastic.co/what-is/hybrid-search
- Qdrant hybrid search（RRF/DBSF）— https://qdrant.tech/documentation/search-tuning/hybrid-search/ ；Query API 课程 — https://qdrant.tech/course/essentials/day-3/hybrid-search/ ；过滤 — https://qdrant.tech/documentation/search-patterns/vector-search-filtering/ 与 https://qdrant.tech/blog/pre-filtering-vs-post-filtering/
- Weaviate hybrid search — https://docs.weaviate.io/weaviate/search/hybrid ；融合算法深潜 — https://weaviate.io/blog/hybrid-search-fusion-algorithms
- Azure AI Search hybrid — https://learn.microsoft.com/azure/search/hybrid-search-overview ；Azure Cosmos DB hybrid — https://learn.microsoft.com/en-us/azure/cosmos-db/gen-ai/hybrid-search
- Vespa phased ranking — https://docs.vespa.ai/en/ranking/phased-ranking.html ；多阶段排序教程 — https://learn.vespa.ai/reranking-ltr/multiphase-ranking ；RAG blueprint — https://github.com/vespa-engine/documentation/blob/master/en/learn/tutorials/rag-blueprint.md
- Cohere Rerank 3.5 API 参考 — https://docs.cohere.com/reference/rerank ；发布公告 — https://cohere.com/blog/rerank-3pt5
- Cohere Rerank 3.5 请求级延迟官方基准（OCI）— https://docs.oracle.com/en-us/iaas/Content/generative-ai/benchmark-cohere-rerank-3-5.htm
- Voyage rerankers — https://docs.voyageai.com/docs/reranker ；rerank-2.5 公告 — https://blog.voyageai.com/2025/08/11/rerank-2-5 ；API 参考 — https://docs.voyageai.com/reference/reranker-api
- Jina reranker v2 — https://jina.ai/news/jina-reranker-v2-for-agentic-rag-ultra-fast-multilingual-function-calling-and-code-search ；模型卡 — https://huggingface.co/jinaai/jina-reranker-v2-base-multilingual
- bge-reranker-v2-m3 模型卡 — https://huggingface.co/BAAI/bge-reranker-v2-m3 ；bge-m3 模型卡 — https://huggingface.co/BAAI/bge-m3
- Qwen3-Embedding 官方博客 — https://qwenlm.github.io/blog/qwen3-embedding ；代码库 — https://github.com/QwenLM/Qwen3-Embedding
- Milvus embedding API 延迟基准（20+ 提供商）— https://milvus.io/blog/we-benchmarked-20-embedding-apis-with-milvus-7-insights-that-will-surprise-you.md
- Zep embedding 延迟实测 — https://www.getzep.com/blog/text-embedding-latency-a-semi-scientific-look
- LangMem — https://langchain-ai.github.io/langmem/ ；hot path quickstart — https://langchain-ai.github.io/langmem/hot_path_quickstart
- Letta（MemGPT 产品化）文档 — https://docs.leta.com ；MemGPT 论文 — https://arxiv.org/abs/2310.08560 ；Graphiti 源码 — https://github.com/getzep/graphiti
- Anthropic memory tool — https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool ；Effective context engineering — https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- OpenAI ChatGPT memory 官方帮助 — https://help.openai.com/en/articles/8590148-memory-in-chatgpt
- LlamaIndex Recursive Retriever（small-to-big）— https://developers.llamaindex.ai/python/framework/integrations/retrievers/recursive_retriever_nodes/
- IBM chunking 策略 — https://developer.ibm.com/articles/awb-enhancing-rag-performance-chunking-strategies
- RankGPT 官方代码（滑窗参数）— https://github.com/sunnweiwei/rankgpt

### 二手（从业者分析 / 社区报告，仅作旁证）

- ZeroEntropy rerank 候选数指南（50–75 最优）— https://zeroentropy.dev/articles/ultimate-guide-to-choosing-the-best-reranking-model-in-2025
- 融合方法横向对比 — https://bigdataboutique.com/blog/hybrid-search-fusion-methods-compared
- BM25/dense 互补机理综述 — https://mbrenndoerfer.com/writing/hybrid-search-bm25-dense-retrieval-fusion ；https://denser.ai/blog/hybrid-search-for-rag/
- 生产 RAG 查询面分析（HyDE 何时负收益）— https://www.ratkonikolic.com/p/advanced-rag-what-you-actually-run
- FTS5 tokenizer 对比笔记 — https://audrey.feldroy.com/articles/2025-01-13-SQLite-FTS5-Tokenizers-unicode61-and-ascii
- 中文 FTS5 tokenizer 社区讨论 — https://github.com/groue/GRDB.swift/issues/413
- RRF 收益甚微的实践反例 — https://www.reddit.com/r/Rag/comments/1sjpl95/hybrid_search_bm25_vectors_rrf_barely_improved
- ChatGPT memory 机制深挖 — https://embracethered.com/blog/posts/2025/chatgpt-how-does-chat-history-memory-preferences-work
- OpenAI embedding 社区延迟实测 — https://community.openai.com/t/embeddings-api-extremely-slow/1135044
- Reranker 延迟评测方法论 — https://zeroentropy.dev/articles/latency-performance-assessment-of-zerank-2

### 仓库内前置结论（引用）
- OpenAI 兼容网关可做 embedding（共享 `LLM_API_KEY`）：`docs/research/725-openwiki-embedding-okf.md`

---

*报告完。数据时效说明：Anthropic contextual retrieval 为 2024-09；Blended RAG 2024；BGE-M3 2024（ACL Findings）；Qwen3/Mem0/Zep 2025；Cohere Rerank 3.5 2024-12；Voyage rerank-2.5 2025-08；verbatim-vs-artifact 对照 2026；Oracle rerank 延迟基准与 Milvus embedding 基准为 2025–2026 页面版本。各 URL 访问核验于 2026-10。*
