# AutoFigure 插件 · 移植来源与版权声明

本目录为 researcher-service 官方插件 AutoFigure 的纯逻辑实现（#744 v2 §3/§10 票 1/2，
产物落位依 #744 §11.4）。

**上游来源**：`ResearAI/AutoFigure-Edit` @ `16f3749`（tag `v1.1`），MIT License，
© Autofigure2 contributors。

本实现为该上游的 **MIT derivative work**（#744 §3.3 移植策略）：prompt 模板、失败语义、
box 解析/合并、SVG 替换策略链、坐标换算等逐字/逐语义移植（各源文件行号注记指上游
`autofigure2.py`）；计算面（SAM3/RMBG）换轨为云 API（fal），图像操作换轨为 sharp
（#744 §0.3），LLM 调用面 Port 化（ProviderRegistry 接缝归票 4）。

上游仓库：<https://github.com/ResearAI/AutoFigure-Edit>（上游许可证：MIT）
