# ruff/pylint 分工边界

## 分工原则

| 层面 | 工具 | 信号 |
|------|------|------|
| **代码风格**（格式、引号、import 排序、尾逗号） | ruff | E/W (pycodestyle) + I (isort) + COM (flake8-commas) |
| **代码质量**（未用变量/import、逻辑错误） | ruff | F (pyflakes) |
| **代码味道**（禁止结构、安全陷阱） | ruff | PIE (flake8-pie)；aspirational: B (flake8-bugbear) + S (bandit) |
| **语义分析**（类型/方法存在性、参数数量、异常链） | pylint | E (error) + W (warning) |
| **设计复杂度**（过多参数/分支/类属性、过长函数） | pylint | R (refactor) + C (convention) |

### 详细分配

**ruff 管**（不交 pylint，防双报）：
- `E501` line-too-long（对应 pylint `line-too-long`）→ ⚠️ ruff 默认集不包含 E50 族，当前为**无门状态**（见下文已知冲突/重叠点备注）
- `F401` unused-import（对应 pylint `unused-import`）
- `F841` unused-variable（对应 pylint `unused-variable`）
- `F403` wildcard-import、`F405` star imports（对应 pylint `wildcard-import`）
- `I001` import 排序（对应 pylint `wrong-import-order` / `ungrouped-imports`）✔ 已使能
- `COM812` 尾逗号 ✔ 已使能
- `Q` 族引号规则 → aspirational（待收敛后使能）
- `B` 族 bugbear 规则 → aspirational（待收敛后使能）

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
| `E501` | `line-too-long` (C0301) | ⚠️ pylint `disable` → ruff 默认集不含 E50 族（`[tool.ruff.lint]` 未选 E501），当前**无门状态**。待 `E501` 使能后方成为 ruff 单一来源。 |
| `F401` | `unused-import` (W0611) | pylint `disable` → ruff 单一来源 |
| `F841` | `unused-variable` (W0612) | pylint `disable` → ruff 单一来源 |
| `F403`/`F405` | `wildcard-import` (W0401/W0614) | pylint `disable` → ruff 单一来源 |
| `BLE001` (ruff) | `broad-exception-caught` (W0718) | 两边都报但目的不同：ruff BLE001 打禁止盲异常标记；pylint W0718 打宽捕获标记。本仓统一在 pylint 层做局部豁免（故障隔离模式有意为之）；ruff BLE001 已在 `[tool.ruff.lint] extend-ignore` 全局收口（不再报）。 |
| `S110`/`S112` (ruff, bandit) | N/A（pylint 无对应） | ruff bandit 安全规则——本仓 `except` 部分与 pylint `broad-exception-caught` 同源（故障隔离），已与 BLE001 一并在 `[tool.ruff.lint] extend-ignore` 收口。raise-without-from-inside-except (B904) 已由 pylint `raise-missing-from` 覆盖。 |

### 双报验证

终端验收 `pylint exit 0` 的配置下（`pyproject.toml` disable 集包含 ruff 重叠项）——**假设已在 venv 环境**（`requirements/dev.txt` 已安装）：

```bash
# ruff 检查（激活的规则见 [tool.ruff.lint]）
ruff check accounts chat config containers models wiki

# pylint 输出（exit 0）
pylint accounts chat config containers models wiki

# 或等价的 python -m 形式
python -m ruff check accounts chat config containers models wiki
python -m pylint accounts chat config containers models wiki
```

输出预期：ruff check 退出码 0（预存噪音 F401/RUF012 等已收敛，BLE001/S110/S112 经 extend-ignore 收口、migrations 经 extend-exclude 跳过）；pylint exit 0。

## 维护约定

- pyproject.toml 中 `[tool.pylint."MESSAGES CONTROL"]` 的 `disable` 集是 pylint 退出码 0 的配置单一来源
- pyproject.toml 中 `[tool.ruff.lint]` 的 `extend-select` 集是 ruff 规则选择之源（现状只使能低噪规则族 I/COM/PIE；Q/B/S 为 aspirational 待收敛）
- 源码中的 `# pylint: disable=...` 一行注释是**局部豁免**（文件/函数/行级），对应异常类型各有说明
- 新增代码若触发 pylint 新规则：优先全局 fix；若为有意的设计权衡则加局部豁免并在此文档登记
- ruff 规则扩展只需在 `[tool.ruff.lint]` 追加 `extend-select` 条目，不干扰 pylint disable 集
- 故障隔离异常模式（BLE001/S110/S112）在 `[tool.ruff.lint] extend-ignore` 收口；migrations 目录在 `[tool.ruff] extend-exclude` 跳过。新增同类模式/路径在此登记
