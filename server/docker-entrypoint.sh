#!/bin/sh
# server 容器入口：先幂等落表（better-sqlite3 直连，不经 prisma CLI），再起 Express 控制面。
# 对齐 Django 镜像「entrypoint = migrate + daphne」模式：migrate 幂等 → 应用起服务。
#
# 两段式（#771 起）：
#   1) apply-schema.mjs —— 逐语句 skip-if-exists 幂等（空库全量 prisma/init.sql；旧库 additive
#      收敛），可重跑。下方 users 表探测只是重启快速路径（跳过全量 init.sql 的文件读取），
#      非正确性关卡——即使探测失准，apply 重跑也只是逐语句跳过。
#   2) upgrade-schema.mjs —— 每次启动跑 additive 增量收敛（新表/新列经
#      lib/incremental-schema.mjs 单一来源），PRAGMA user_version 置 SCHEMA_VERSION。
set -e

SCHEMA_SCRIPT=$(cat <<'INNER'
const D = require('better-sqlite3')
const db = new D(process.env.DATABASE_URL.replace(/^file:/, ''))
const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get()
process.exit(row ? 0 : 1)
INNER
)

echo "[entrypoint] checking schema (users table present?)..."
if node -e "$SCHEMA_SCRIPT"; then
  echo "[entrypoint] base schema already applied"
else
  echo "[entrypoint] applying schema..."
  node scripts/apply-schema.mjs
fi
echo "[entrypoint] applying incremental schema upgrades..."
node scripts/upgrade-schema.mjs

echo "[entrypoint] starting control plane on :8001..."
exec node dist/server.js
