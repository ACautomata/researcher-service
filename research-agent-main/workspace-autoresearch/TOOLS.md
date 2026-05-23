# TOOLS.md - Local Notes

## 论文处理

- PDF 全文提取优先用本地 PDF 解析，摘要获取可用 arXiv API
- 论文元数据：CrossRef / Semantic Scholar API 补充 DOI、引用信息
- 代码仓库：GitHub 链接记录在 paper frontmatter 的 `code` 字段

## 工作空间

- `raw/` — 不可变原始文件，规范命名 `YYYY-MM-DD-short-title.ext`
- `wiki/` — 维护层，中文呈现，按 domain 分层
- `wiki/index.md` — 第一检索入口，每次 durable page 变更后更新
- `wiki/log.md` — 追加式时间线，每次操作后记录

## 为什么分开

Skills 定义工具怎么用，这个文件记录本 agent 特有的配置和路径。分开意味着更新 skills 不会丢失本地笔记。
