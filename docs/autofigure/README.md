# docs/autofigure —— 历史档案（换轨前调研/规格/票据）

本目录是 AutoFigure **换轨前**（#791 由 Python sidecar 换轨为控制面插件管线）的调研与规格档案：
reconnaissance（换轨前代码库现状调研）、spec / grilling-decisions / tickets（sidecar 方案设计与
拆票）。**内容按当时现状撰写，不随现役演化更新**——文中对编排形态、配置面、镜像链的描述
（含 OpenClaw fleet 时代机制）均为历史快照；现役事实以根 README、`server/README.md` 与
GLOSSARY.md 为准。档案不回删、不改写（#861 退役终局同 docs/research/、docs/adr/ 先例）。

现役 AutoFigure 实现：`server/src/plugins/autofigure*` + `plugins/autofigure/`；env 面见
`deploy/README.md`「AutoFigure env」。
