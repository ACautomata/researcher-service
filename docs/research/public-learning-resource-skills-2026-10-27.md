# 公开学习资源检索：GitHub skills 调研

调研日期：2026-10-27。范围：只读核对原仓库、SKILL.md、部分实现与官方 API 文档；没有安装或执行第三方 skill，没有实测服务召回质量、费用、延迟或中文视频成功率。下面的维护时间是 GitHub API 返回的仓库 `pushed_at`，只能说明有推送，不能证明每个 skill 已验证可用。本文不使用 stars 衡量资源可信度。

## 结论

可以参考现有 skills 的检索与阅读流程，但**没有发现一个经本次核对即可包办“权威来源筛选 + 热门排序 + 中文视频/文档阅读”的现成方案**。技能是操作说明和工具封装，搜索结果的相关度、播放量和带引用的回答均不能单独证明内容可靠。

第一版可采用“一种通用搜索 API + 原站链接 + 来源标识/可信依据 + 独立热度字段”；正文和字幕阅读作为后续增强。API 应通过平台自己的类型化适配层调用，避免把第三方 shell skill 原样当成服务器功能。

## 候选对照

| 候选与原始说明 | 已核对能力、依赖 | 可借鉴 | 缺口与采用边界 | 许可证 / 最近推送 UTC |
| --- | --- | --- | --- | --- |
| [Tavily 官方 skills](https://github.com/tavily-ai/skills)，[search](https://github.com/tavily-ai/skills/blob/main/skills/tavily-search/SKILL.md)、[research](https://github.com/tavily-ai/skills/blob/main/skills/tavily-research/SKILL.md) | 搜索、域名/日期限制、相关摘要，另有 extract/map/crawl/research；研究流程规定多源整理及引用；生产服务通常需要 Tavily 认证或 `TAVILY_API_KEY` | 查询拆解、域名过滤、先检索再提取、结构化来源与引用 | 相关度不是可信度；未核实 B 站搜索/字幕或教育领域权威目录。有限 keyless 用法不能推导生产免费无限使用 | MIT；2026-10-26 21:05:50 |
| [Exa 官方 agent-skills](https://github.com/exa-labs/agent-skills)，[exa-search](https://github.com/exa-labs/agent-skills/blob/main/skills/exa-search/SKILL.md)、[exa-contents](https://github.com/exa-labs/agent-skills/blob/main/skills/exa-contents/SKILL.md) | `api.exa.ai/search`，`EXA_API_KEY`；语义检索、域名/日期约束、摘要/正文与内容新鲜度控制；contents 需核对每个 URL 状态 | 面向产品的搜索/正文 API 分层、保留原始 URL、局部失败处理 | 搜索类型与相关度不等于经过编辑审核；没有核实中文课程/视频效果与平台播放量能力 | MIT；2026-10-26 17:54:44 |
| [Firecrawl 官方 skills](https://github.com/firecrawl/skills)，[search](https://github.com/firecrawl/skills/blob/main/skills/core/firecrawl-search/SKILL.md)、[scrape](https://github.com/firecrawl/skills/blob/main/skills/core/firecrawl-scrape/SKILL.md)、[build-search](https://github.com/firecrawl/skills/blob/main/skills/build/firecrawl-build-search/SKILL.md) | CLI/服务覆盖网页检索、查询相关片段、可选正文抓取；另有站内 map/crawl 与工作流。云服务需要账户/API key；自行部署需另评估对应组件 | 搜索与抓取结果复用、只读取有价值页面、空结果/逐项错误处理；build 类说明适合产品集成 | 工具目录中的匹配只代表候选能力，必须查看契约后才知覆盖；gov 索引是美国法政范围，不是全球权威教育资源白名单；不是 B 站搜索保证 | skills 分发仓库 ISC；上游实现另查许可证；2026-10-22 13:45:24 |
| [artemchuikin/youtube-skills](https://github.com/artemchuikin/youtube-skills)，[youtube-search](https://github.com/artemchuikin/youtube-skills/blob/main/skills/youtube-search/SKILL.md)、[transcript](https://github.com/artemchuikin/youtube-skills/blob/main/skills/transcript/SKILL.md) | 第三方 **TranscriptOut** 服务，`TRANSCRIPTOUT_API_KEY`，不是 Google 官方 API；搜索返回频道、发布时间、时长、播放量等，再按选中视频读取字幕 | 先元数据筛选、再读取少量视频；频道级约束；热度字段和字幕证据分开 | 第三方服务可用性、计费与访问地域另测；无字幕/删除/受限视频有失败状态；标题和播放量不证明讲解正确，也未覆盖 B 站 | MIT；2026-10-15 09:00:55 |
| [yichen11818/bilibili-video-reader](https://github.com/yichen11818/bilibili-video-reader)，[SKILL.md](https://github.com/yichen11818/bilibili-video-reader/blob/main/SKILL.md)、[实现](https://github.com/yichen11818/bilibili-video-reader/blob/main/scripts/read_bilibili_video.py) | 输入已知 bilibili.com / b23.tv 链接，读取元数据/字幕；可选音频转写与抽帧，依赖 yt-dlp 等，ASR 可用本地 faster-whisper 或外部 API | 原字幕优先、无字幕时明确使用 ASR、课件型视频结合画面、时间戳定位；弹幕仅补充 | **不是已验证的关键词搜索服务**；无账号/风控/播放页稳定性保证；GitHub license 为 null，树中未见 LICENSE，暂仅参考流程思想，不能据此认定可复制再分发 | 未声明许可证；2026-03-22 03:43:06 |

上述内容均根据链接中的说明或实现核对，不把 README 的性能宣传当成实测结果。仓库许可证只覆盖对应开源材料，不能替代 API 服务条款、源站内容授权或下游依赖许可证。

## 热门视频的可靠取数方式

若首版支持 YouTube，官方 [search.list](https://developers.google.com/youtube/data/reference/rest/v3/search/list) 与 [videos.list](https://developers.google.com/youtube/data/reference/rest/v3/videos/list) 可作为独立适配器的依据：先发现候选，再获取视频资料/统计；`mostPopular` 有区域、类别条件，不等于某门课程最适合的教材，也不等于学术权威。配额与授权应按实际选用端点核对，不凭旧记忆写死价格或配额。

本次没有核实到可承诺稳定覆盖的 B 站官方公开全网关键词检索契约。不能因为一个 reader 能读已知 URL，就在设计中写成“已具备 B 站搜索”。若产品主要服务中文学生，应先用真实关键词样本验证中文搜索召回、原站链接可打开率，以及可依法取得的作者/热度字段。

## 可靠性应该成为平台规则

以下是待产品决策的建议，尚非用户已确认需求：

1. **先定可收录来源，再排热度。** 用发布机构和具体频道的来源登记表，区分高校/科研机构/政府或标准组织/官方产品文档、已核实身份的个人教学内容、其他社区资源。不能把整个平台域名视为权威作者。
2. **每条结果显示可核验依据。** 至少有原站 URL、发布者、原发或转载、发布日期/抓取时间、内容类型；“可靠”标签必须能解释来自哪个登记规则，未知字段保持未知。链接有效性与内容正确性分别判断。
3. **热度独立显示。** 保存具体指标、取数时间、平台；跨平台播放量口径不同，不直接相加。不要把“热门”改写成“权威”。
4. **阅读后才生成内容结论。** 搜索摘要只用于选候选；正文需可追溯原文片段，视频需字幕/ASR来源及时间戳，ASR与官方字幕明确区分。参考文献存在不代表结论已被参考文献支持。
5. **先做小样本验收。** 由目标专业教师/学生给出真实关键词和优质示例，记录前若干条的相关性、权威来源占比、可打开率、重复率、错误标记和耗时。工具厂商的 demo 无法替代这些指标。

不能先给一个看似精确的“可信度 92 分”；第一版更适合解释性标签、来源证据和可打开的原文链接。

## 当前仓库可复用部分

已阅读本地 `plugins/research/discover.ts`：它通过 `PluginWikiPort.search/readPage/createPage` 对已入库 `papers/` 论文页进行定位、读取与证据检查，属于内部 wiki 工作流，不能视为现成的外部全网搜索。其来源引用与验证思路可参考，但外部搜索应有单独端口/结果模型，避免混淆“公开网页候选”与“已入库论文证据”。

本次未全面审计服务器所有联网能力；这个结论仅针对已检查的 research 插件入口。没有改动现有实现，也没有上线任何功能。

## 需要先问清的取舍

- 第一批学科与用户层次：专业课入门、课程考试、科研进阶的权威来源和排序目标不同。
- 中文与英文的优先级，以及用户能否实际打开候选站点。
- “推荐可信材料”与“广泛发现社区材料”是否作为两个可解释入口。
- 首版只跳转原站是否足够，还是必须阅读正文/字幕后才能入选；这决定成本与失败面。
