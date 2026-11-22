#!/usr/bin/env bash
# #1088 非自动门禁人工冒烟：当前代码 + 真 Docker/Redis + 脚本模型，全部是隔离合成数据。
set -euo pipefail
rf_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
rf_tmp="$(mktemp -d /tmp/rf1088-container.XXXXXX)"
rf_name="rf1088-acceptance-$$"
rf_redis="${rf_name}-redis"
rf_port="${RF_ACCEPTANCE_HTTP_PORT:-38089}"
rf_report="${RF_ACCEPTANCE_REPORT:-/tmp/${rf_name}-report.json}"
cleanup() {
  curl -fsS "http://127.0.0.1:${rf_port}/__acceptance/report" > "${rf_report}" 2>/dev/null || true
  docker stop --time 30 "${rf_name}" >/dev/null 2>&1 || true
  docker rm -f "${rf_name}" "${rf_redis}" >/dev/null 2>&1 || true
  docker network rm "${rf_name}" >/dev/null 2>&1 || true
  rm -rf "${rf_tmp}"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
cd "${rf_root}/server"
docker info >/dev/null
npx tsc -p tsconfig.json --outDir "${rf_tmp}/code"
mkdir -p "${rf_tmp}/code/server/prisma"
cp -R src/generated "${rf_tmp}/code/server/src/"
cp prisma/init.sql prisma/history-triggers.sql prisma/reflection-triggers.sql prisma/reflection-owner-trigger.sql prisma/reflection-recovery.sql "${rf_tmp}/code/server/prisma/"
cp src/sessions/history/sqliteCore.cjs "${rf_tmp}/code/server/src/sessions/history/"
cp src/reflections/reflectionCore.cjs "${rf_tmp}/code/server/src/reflections/"
cp src/utils/readonlyProcessChild.cjs "${rf_tmp}/code/server/src/utils/"
docker network create "${rf_name}" >/dev/null
docker run -d --name "${rf_redis}" --network "${rf_name}" redis:7-alpine >/dev/null
docker create --name "${rf_name}" --network "${rf_name}" --entrypoint sh \
  -p "127.0.0.1:${rf_port}:38088" -v /var/run/docker.sock:/var/run/docker.sock \
  -e NODE_ENV=test -e JWT_SECRET=test-secret-fixed -e RF_ACCEPTANCE_REAL_DOCKER=1 \
  -e "RF_ACCEPTANCE_REDIS_URL=redis://${rf_redis}:6379/0" -e NODE_PATH=/tmp/extra/node_modules \
  "${RF_ACCEPTANCE_IMAGE:-panel-server:dev}" -c '
    set -e
    mkdir -p /tmp/acceptance
    cp -R /compiled/. /tmp/acceptance/
    ln -s /app/node_modules /tmp/acceptance/server/node_modules
    npm install --prefix /tmp/extra --ignore-scripts --no-save multer@2.4.0 adm-zip@0.6.1 @xmldom/xmldom@0.9.12 openwiki@0.6.1 sharp@0.35.5 @modelcontextprotocol/sdk@1.32.1 >/tmp/deps.log 2>&1
    cd /tmp/acceptance/server
    exec node scripts/acceptance/reflection-browser-server.js
  ' >/dev/null
docker cp "${rf_tmp}/code" "${rf_name}:/compiled"
docker start "${rf_name}" >/dev/null
printf '独立后端：http://127.0.0.1:%s\n前端：cd frontend && VITE_ACCEPTANCE_FIXTURE=1 VITE_API_TARGET=http://127.0.0.1:%s npm run dev\n合成账号：rf-eval / synthetic-evaluation-password\nCtrl-C 清理；报告：%s\n' "${rf_port}" "${rf_port}" "${rf_report}"
docker logs -f "${rf_name}"
