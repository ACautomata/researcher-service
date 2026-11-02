# 公开学习资源检索：搜索与正文 API 调研

核对日期：2026-10-27。仅查阅厂商公开资料，没有注册账户、调用付费 API 或读取用户凭证。价格可能变动，实际开通前应再次核对账单规则。不同厂商的 credit 不能直接互换，也不等于美元。

## 价格与额度

| 服务 | 免费额度 | 搜索与正文的公开价格 | 控制和限制 |
| --- | --- | --- | --- |
| Tavily | 每月 1,000 API credits，无需信用卡；每月 1 日重置。 | basic 搜索每次 1 credit，advanced 每次 2 credits；basic 正文提取每 5 个成功 URL 1 credit，advanced 每 5 个 2 credits。按量方案 $0.008/credit。 | API key 可设置每月 credit 限额；官方说明开发 key 为 100 次/分钟，生产 key 为 1,000 次/分钟，具体端点可能有独立限流。免费额度耗尽后需等待重置或升级。 |
| Exa | 每月 $10 额度，另有一次性 $10 入门赠额，无需支付方式。 | 最多 10 条结果时，Lite、Auto、Deep 分别为每 1,000 次 $4、$7、$12；超过 10 条时每增加一条结果，每 1,000 次加 $1。Contents 每种内容类型每 1,000 页 $1，AI 页面摘要另按每 1,000 页 $1 列价。 | Starter 搜索 10 QPS，按量计划最高 25 QPS；本次未确认供应商端硬性月消费上限或免费赠额耗尽后的具体行为。 |
| Firecrawl | 每月 1,000 credits，无需信用卡；共享于各端点。 | 搜索每 10 条结果 2 credits，基础网页抓取每页 1 credit，搜索附带正文提取需叠加抓取费用；JSON、Question、Highlight 格式额外每页 4 credits。Hobby 5,000 credits/月，按月付 $19/月或按年付折合 $16/月。 | 免费计划 2 个并发请求；按量超额仅付费计划提供，以 $5 为单位加购，可设置每月限额。每 10 条结果的不足 10 条和尾数如何计费，结算前需确认。 |

来源：[Tavily 定价](https://www.tavily.com/pricing)、[搜索计费](https://help.tavily.com/articles/6938147944-basic-vs-advanced-search-what-s-the-difference)、[正文提取](https://docs.tavily.com/documentation/api-reference/endpoint/extract)、[密钥限额](https://help.tavily.com/articles/9170796666-how-can-i-create-an-api-key)、[限流](https://help.tavily.com/articles/3240802908-rate-limits)；[Exa 定价](https://exa.ai/pricing)；[Firecrawl 定价](https://www.firecrawl.dev/pricing)、[搜索与提取说明](https://www.firecrawl.dev/blog/mastering-firecrawl-search-endpoint)。

Tavily 提取使用量可能在成功提取不足 5 个 URL 时显示为 0；不能假设每次请求都向上取整，也不能仅按单次响应判断最终成本。Firecrawl 的 [2026-08-17 官方更新](https://www.firecrawl.dev/changelog/may5)称增强模式按基础请求同样的 1 credit 计费、自动升级重试不另收费；实际费用和 PDF 等附加格式应在启用前核对。

## 接口能力与约束

- [Tavily Search](https://docs.tavily.com/documentation/api-reference/endpoint/search) 支持 `include_domains` 和 `exclude_domains`；`include_domains_mode=restrict` 为硬限制，`prefer` 仍可能返回其他域名。搜索结果可包含标题、URL、摘要，`include_raw_content` 可请求正文；[Extract](https://docs.tavily.com/documentation/api-reference/endpoint/extract) 分别返回成功和失败 URL，即使 HTTP 200 也可能没有成功正文。显式指定 `search_depth=basic`，避免自动参数选择更昂贵的深度。
- [Exa Search](https://exa.ai/docs/reference/search) 支持 `includeDomains`、`excludeDomains` 和 `contents.text`／`contents.highlights`，响应示例包含标题、URL、出版日期、作者、正文和引用片段等字段；字段是否存在取决于内容和请求。API 参考中 `lite` 有可接受参数范围，不能假设所有模式参数兼容。结果中的 `costDollars` 可用于核对账单，但不是请求前的硬预算保证。
- [Firecrawl Search](https://docs.firecrawl.dev/api-reference/endpoint/search) 支持 `includeDomains` 或 `excludeDomains`，两者互斥，值为主机名；可请求网页、新闻等，使用 `scrapeOptions` 请求 Markdown 正文。其文档声明 `research` 类别将于 **2026-11-16** 改变数据源和响应结构，适配时不能将当前结构视为永久契约。返回标题、描述和 URL 不保证正文可访问。

域名名单只是信源筛选工具，不等同于事实正确、内容授权、视频质量或热门程度。搜索热度、播放量、账号真实性和具体视频可用性需要来源平台的独立数据验证。

## 对本项目的试点建议

先以 Tavily basic 作为候选主搜索，Exa Lite 作为对照；Firecrawl 留作正文提取候选。原因是三者均有免费额度、域名筛选和正文能力，且 Tavily 可按 key 限制月使用量；这只是工程起点，不是中文质量排名。用同一批匿名化的真实学习问题比较权威来源命中率、可打开链接比例、正文可用率、响应时间与实际账单，再决定是否支付或切换服务。先返回可直接访问的原始来源链接与简短依据；正文失败时保留链接并标明限制，不能虚构内容。

试点默认只检索公开页面，对每个问题限制检索次数、结果数、提取页数、超时和重试次数；为用户和整个平台设置服务端用量上限并记录供应商实际用量。只按允许名单选择提取对象，验证链接和重定向目标，避免把检索返回的任意 URL 当作可信网络地址。应尊重站点的访问与使用限制。付费额度、是否自动续费及预算上限需在服务商控制台确认；不能把应用内计数当成供应商账单硬上限。

现有项目可参考：`server/src/chaoxing/client.ts` 已使用取消信号、超时和禁止重定向；`server/src/chaoxing/options.ts` 对配置使用 schema 校验；`server/src/models/service.ts` 对持久化密钥加密并在视图中遮掩。新服务的权限、配额和网络安全边界仍需单独设计，不能直接推定现有实现已覆盖公开搜索。

尚未验证：三家在中国大陆部署环境的连通性、中文学习问题召回、B 站或其他视频平台的覆盖与热度字段、链接可打开率、正文提取的授权条件、支付可用性和计费尾数。这些都须用符合授权的试点账号及样例实测。
