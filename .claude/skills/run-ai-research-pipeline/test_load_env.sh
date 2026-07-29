#!/usr/bin/env bash
# 回归：driver.sh _load_env 的 shell-over-file 环境变量优先级（codex P2 :64）。
#   bash .claude/skills/run-ai-research-pipeline/test_load_env.sh
#
# 验证：deploy/.env 不得覆盖调用方已显式设置的 shell 环境变量（含显式空值），
# 仅注入调用方当前未设置的变量——对齐 python-dotenv load_dotenv() 不覆盖语义。
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# 加载被测函数。driver.sh 末尾 case 在无 $1 时走 help 分支仅打印用法（已重定向）；
# 随后放宽 driver.sh 设置的 set -euo pipefail 以便本测试自行管理失败计数。
# shellcheck disable=SC1091
source "$SCRIPT_DIR/driver.sh" >/dev/null 2>&1
set +e +u +o pipefail 2>/dev/null || true

export -f _load_env

failures=0
assert_eq() {  # <got> <want> <label>
  if [ "$1" = "$2" ]; then echo "ok   - $3"; else echo "FAIL - $3: got '$1' want '$2'"; failures=$((failures + 1)); fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
envf="$tmp/.env"
printf 'GATEWAY_TOKEN=gt-file\nLLM_API_KEY=key-file\nOPENCLAW_IMAGE=img-file\n# COMMENT=skip\nNOTHING\n' > "$envf"

# 子 shell（bash -c）跑，隔离本进程 env，且不继承本 shell 的 set 选项。
# 先 unset 受测变量以排除宿主环境继承（host 可能已 export OPENCLAW_IMAGE/LLM_API_KEY），
# 使每个用例从已知空状态出发。

# ① shell 已设置的变量胜出；未设置的从 .env 注入
out=$(bash -c '
  unset LLM_API_KEY GATEWAY_TOKEN OPENCLAW_IMAGE
  export LLM_API_KEY=key-shell
  _load_env "$1" >/dev/null
  printf "%s\n%s\n%s\n" "$LLM_API_KEY" "$GATEWAY_TOKEN" "$OPENCLAW_IMAGE"
' _ "$envf")
llm=$(sed -n '1p' <<<"$out"); gt=$(sed -n '2p' <<<"$out"); img=$(sed -n '3p' <<<"$out")
assert_eq "$llm" "key-shell" "shell-set LLM_API_KEY 不被 .env 覆盖"
assert_eq "$gt"   "gt-file"  "未设置的 GATEWAY_TOKEN 从 .env 注入"
assert_eq "$img"  "img-file" "未设置的 OPENCLAW_IMAGE 从 .env 注入"

# ② shell 显式空值也胜出（不被 .env 的 key-file 覆盖——codex 描述的核心 bug 场景）
out=$(bash -c '
  unset LLM_API_KEY
  export LLM_API_KEY=""
  _load_env "$1" >/dev/null
  printf "%s\n" "$LLM_API_KEY"
' _ "$envf")
assert_eq "$(sed -n '1p' <<<"$out")" "" "shell 显式空 LLM_API_KEY 胜出（不被 .env 覆盖）"

# ③ 全未设置 → 全部从 .env 注入（默认加载路径仍工作）
out=$(bash -c '
  unset LLM_API_KEY
  _load_env "$1" >/dev/null
  printf "%s\n" "$LLM_API_KEY"
' _ "$envf")
assert_eq "$(sed -n '1p' <<<"$out")" "key-file" "无 shell 覆盖时 LLM_API_KEY 从 .env 注入"

# ④ 含非法标识符的键（如 BAD-KEY=x）整行跳过；不再因间接展开抛 invalid-variable-name
# （codex P2 :79）：原 regex 仅校验首字符，间接展开 "${!key+x}" 会因含 `-` 报错 → set -e
# 终止 driver.sh → 前后端均不启动。注意：bash 内置 `unset BAD-KEY` 对非合法 identifier
# 会 fatal exit 整个 subshell，须用 `|| true` 让 unset 失败不破坏后续 _load_env 跑。
printf 'BAD-KEY=x\nGOOD_KEY=y\nANOTHER-BAD=z\n' > "$envf"
out=$(bash -c '
  unset GOOD_KEY 2>/dev/null || true
  unset BAD-KEY 2>/dev/null || true
  unset ANOTHER-BAD 2>/dev/null || true
  _load_env "$1" >/dev/null
  printf "%s\n" "${GOOD_KEY}"
' _ "$envf")
assert_eq "$(sed -n '1p' <<<"$out")" "y" "非法标识符的键被整行跳过（合法 GOOD_KEY=y 仍注入）"

echo "---"
if [ "$failures" -eq 0 ]; then echo "全部通过"; exit 0; else echo "$failures 项失败"; exit 1; fi
