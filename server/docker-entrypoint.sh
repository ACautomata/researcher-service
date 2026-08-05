#!/bin/sh
# server 容器入口：先幂等落表（better-sqlite3 直连 init.sql），再起 Express 控制面。
# 对齐 Django 镜像「entrypoint = migrate + daphne」模式：migrate 幂等 → 应用起服务。
#
# init.sql 非幂等（无 IF NOT EXISTS），裸跑重复执行抛 "table users already exists"。
# 幂等判定用「裸 users 表是否存在」：Prisma schema @@map 落表名 users（与 Django 带前缀
# 表名 auth_user/accounts_* 不冲突，旧库残留不会误判）；表在 = 已落表（重启跳过），
# 表不在 = 首启/旧库（跑 apply-schema 建表，Django 旧数据自然废弃）。apply 成功后置
# PRAGMA user_version=1 作迁移位标记（对齐 SQLite 迁移惯例，供未来真实迁移使用）。
set -e

SCHEMA_CHECK='node:better-sqlite3-schema-check'
SCHEMA_SCRIPT=$(cat <<'EOF'
const D = require('better-sqlite3')
const db = new D(process.env.DATABASE_URL.replace(/^file:/, ''))
const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get()
process.exit(row ? 0 : 1)
EOF
)

echo "[entrypoint] checking schema (users table present?)..."
if node -e "$SCHEMA_SCRIPT"; then
  echo "[entrypoint] schema already applied, skipping"
else
  echo "[entrypoint] applying schema..."
  node scripts/apply-schema.mjs
  node -e "const D=require('better-sqlite3');const db=new D(process.env.DATABASE_URL.replace(/^file:/,''));db.exec('PRAGMA user_version=1');db.close()"
fi

echo "[entrypoint] starting control plane on :8001..."
exec node dist/server.js
