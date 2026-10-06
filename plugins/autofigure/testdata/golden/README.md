# AutoFigure golden-file 对照数据

> 采集方法（一次性，需运行外部上游代码）：上游 `ResearAI/AutoFigure-Edit @ 16f3749`
> 的纯函数经 LLM 调用面 monkeypatch 后真跑（`/tmp` 侧脚本 `dump_golden.py`），dump prompt
> 文本与纯逻辑输出为 `upstream.json`。**golden 文件提交入库**——`upstream.json` 存在时
> `server/test/autofigureGolden.test.ts` 自动激活逐字节对照（文件缺失时整体 skip）。

## 采集脚本（生成器，已入库）

```bash
clone_dir=/tmp/autofigure-edit-791  # ResearAI/AutoFigure-Edit @ 16f3749（NOTICE.md pin）
python3 plugins/autofigure/testdata/golden/dump-golden.py \
    plugins/autofigure/testdata/golden/upstream.json --upstream $clone_dir
```


`dump-golden.py`（本目录）monkeypatch 上游 LLM 调用面（捕获 prompt + 固定 fixture 返回）与
`svg_to_png`，真跑上游纯函数（生图/模板三变体/fix 固定注入 errors/optimize 迭代/五策略链替换/
保底 embedded/解析与合并直调），产出本套件消费的 golden JSON。需一次性运行外部上游代码
（pip 依赖 pillow，无网络调用）。

## 差异豁免面

- `validate_svg_syntax` 错误消息：lxml vs `@xmldom/xmldom` 格式不同——消息只进 fix
  prompt（LLM 消费）；golden 采集用固定注入 errors，TS 侧以同一 errors 对照。
- `samed` 标记图为栅格渲染（PIL 字体）：golden 只覆盖 overlay 构造的纯逻辑不变量。
- `optimize` 轮 2 prompt 含轮 1 输出——golden 按真实迭代链采集。
