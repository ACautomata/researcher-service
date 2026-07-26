# ruff/pylint 分工边界

## 分工原则

| 层面 | 工具 | 信号 |
|------|------|------|
| **代码风格**（格式、引号、import 排序、尾逗号） | ruff | E/W (pycodestyle) + I (isort) + Q (flake8-quotes) + COM (flake8-commas) |
| **代码质量**（未用变量/import、逻辑错误） | ruff | F (pyflakes) |
| **代码味道**（禁止结构、安全陷阱） | ruff | B (flake8-bugbear) + S (bandit) + PIE (flake8-pie) |
| **语义分析**（类型/方法存在性、参数数量、异常链） | pylint | E (error) + W (warning) |
| **设计复杂度**（过多参数/分支/类属性、过长函数） | pylint | R (refactor) + C (convention) |

### 详细分配

**ruff 管**（不交 pylint，防双报）：
- `E501` line-too-long（对应 pylint `line-too-long`）
- `F401` unused-import（对应 pylint `unused-import`）
- `F841` unused-variable（对应 pylint `unused-variable`）
- `F403` wildcard-import、`F405` star imports（对应 pylint `wildcard-import`）
- `I001` import 排序（对应 pylint `wrong-import-order` / `ungrouped-imports`）
- `B` 族 bugbear 规则（对应 pylint 部分 W）
- `Q` 族引号规则

**pylint 管**（ruff 默认规则集不碰）：
- `no-member`（E1101）：属性/方法存在性验证
- `no-value-for-parameter`（E1120）：函数调用缺少必需参数
- `raise-missing-from`（W0707）：异常链断裂
- `broad-exception-caught`（W0718）：过于宽泛的异常捕获
- `too-many-*`（R0911/R0912/R0913/R0917/R0902）：设计复杂度门
- `arguments-differ`（W0221）：方法签名的有意覆盖
- `attribute-defined-outside-init`（W0201）：框架惯例中的属性定义
- `try-except-raise`（W0706）：异常处理模式
- `not-callable`（E1102）：可调用性检查
- `inconsistent-return-statements`（R1710）：返回值一致性

## 已知冲突/重叠点

| ruff 规则 | pylint 消息 | 处置 |
|-----------|------------|------|
| `E501` | `line-too-long` (C0301) | pylint `disable` → ruff 单一来源 |
| `F401` | `unused-import` (W0611) | pylint `disable` → ruff 单一来源 |
| `F841` | `unused-variable` (W0612) | pylint `disable` → ruff 单一来源 |
| `F403`/`F405` | `wildcard-import` (W0401/W0614) | pylint `disable` → ruff 单一来源 |
| `BLE001` (ruff) | `broad-exception-caught` (W0718) | 两边都报但目的不同：ruff BLE001 打禁止盲异常标记；pylint W0718 打宽捕获标记。本仓统一在 pylint 层做局部豁免（故障隔离模式有意为之），ruff BLE001 是预存噪音（未配 `.ruff.toml` ignore）。 |
| `S110`/`S112` (ruff, bandit) | N/A（pylint 无对应） | ruff bandit 安全规则——本仓 `except` 部分与 pylint `broad-exception-caught` 同源（故障隔离）；raise-without-from-inside-except (B904) 已由 pylint `raise-missing-from` 覆盖。 |

### 双报验证

终端验收 `pylint exit 0` 的配置下（`pyproject.toml` disable 集包含 ruff 重叠项）：

```bash
# ruff 默认规则集输出
uv run ruff check accounts chat config containers models wiki

# pylint 输出（exit 0）
uv run pylint accounts chat config containers models wiki
```

结论：pylint disable 集中列出的 `line-too-long` / `unused-import` / `unused-variable` / `wildcard-import` / `wrong-import-order` 等规则已全局禁用，**不存在 ruff 与 pylint 对同一缺陷的重复报告**。ruff 和 pylint 各自主责的规则域没有重叠。

## 维护约定

- pyproject.toml 中 `[tool.pylint."MESSAGES CONTROL"]` 的 `disable` 集是 pylint 退出码 0 的配置单一来源
- 源码中的 `# pylint: disable=...` 一行注释是**局部豁免**（文件/函数/行级），对应异常类型各有说明
- 新增代码若触发 pylint 新规则：优先全局 fix；若为有意的设计权衡则加局部豁免并在此文档登记
- ruff 规则扩展（如开启 I/isort）只需 in-tree `.ruff.toml` 或 `[tool.ruff]` 节，不干扰 pylint disable 集
