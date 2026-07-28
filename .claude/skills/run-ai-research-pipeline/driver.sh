#!/usr/bin/env bash
# run-ai-research-pipeline driver —— 启动/停止/健康检查 前后端开发服务器
#
# 用法：
#   .claude/skills/run-ai-research-pipeline/driver.sh start    # 后台启动前后端
#   .claude/skills/run-ai-research-pipeline/driver.sh stop     # 停止前后端
#   .claude/skills/run-ai-research-pipeline/driver.sh status   # 健康检查
#   .claude/skills/run-ai-research-pipeline/driver.sh wait     # 阻塞等待两端就绪（超时 30s）
#
# PID 文件写入 /tmp/ai-research-pipeline-{backend,frontend}.pid
# 日志写入 /tmp/ai-research-pipeline-{backend,frontend}.log

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# 项目根目录（.claude/skills/run-ai-research-pipeline/ → 项目根）
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

BACKEND_DIR="$PROJECT_ROOT/backend"
FRONTEND_DIR="$PROJECT_ROOT/frontend"
BACKEND_PID_FILE="/tmp/ai-research-pipeline-backend.pid"
FRONTEND_PID_FILE="/tmp/ai-research-pipeline-frontend.pid"
BACKEND_LOG="/tmp/ai-research-pipeline-backend.log"
FRONTEND_LOG="/tmp/ai-research-pipeline-frontend.log"
BACKEND_PORT=8000
FRONTEND_PORT=5173
WAIT_TIMEOUT=30

_ensure_venv() {
  if [ ! -f "$BACKEND_DIR/.venv/bin/python" ]; then
    echo "[driver] 创建 backend virtualenv …"
    python3 -m venv "$BACKEND_DIR/.venv"
    "$BACKEND_DIR/.venv/bin/pip" install -r "$BACKEND_DIR/requirements/dev.txt"
  fi
}

_ensure_node_modules() {
  # 不仅仅检查目录存在——检查 package.json 中的依赖是否已全部安装。
  # node_modules 目录可能因 npm 中途中断、手动删除子目录、或 worktree 软链而部分缺失。
  if [ -d "$FRONTEND_DIR/node_modules" ]; then
    cd "$FRONTEND_DIR"
    if npm ls --depth=0 --silent 2>/dev/null; then
      return 0
    fi
    echo "[driver] node_modules 不完整，重新安装 …"
  else
    echo "[driver] 安装 frontend 依赖 …"
  fi
  cd "$FRONTEND_DIR" && npm install
}

_ensure_db() {
  echo "[driver] 运行 Django migrate …"
  cd "$BACKEND_DIR"
  DJANGO_SETTINGS_MODULE=config.settings.dev .venv/bin/python manage.py migrate --noinput 2>&1 | tail -3
}

_is_pid_alive() {
  local pid="$1"
  kill -0 "$pid" 2>/dev/null
}

_health_backend() {
  curl -sf -o /dev/null "http://localhost:$BACKEND_PORT/api/health" 2>/dev/null
}

_health_frontend() {
  curl -sf -o /dev/null "http://localhost:$FRONTEND_PORT" 2>/dev/null
}

cmd_start() {
  _ensure_venv
  _ensure_node_modules
  _ensure_db

  # ---- backend ----
  if [ -f "$BACKEND_PID_FILE" ] && _is_pid_alive "$(cat "$BACKEND_PID_FILE")"; then
    echo "[driver] backend 已在运行 (pid $(cat "$BACKEND_PID_FILE"))"
  else
    echo "[driver] 启动 Django (port $BACKEND_PORT) …"
    cd "$BACKEND_DIR"
    DJANGO_SETTINGS_MODULE=config.settings.dev \
      nohup .venv/bin/python manage.py runserver "localhost:$BACKEND_PORT" \
      > "$BACKEND_LOG" 2>&1 &
    echo $! > "$BACKEND_PID_FILE"
    echo "[driver] backend pid=$(cat "$BACKEND_PID_FILE")"
  fi

  # ---- frontend ----
  if [ -f "$FRONTEND_PID_FILE" ] && _is_pid_alive "$(cat "$FRONTEND_PID_FILE")"; then
    echo "[driver] frontend 已在运行 (pid $(cat "$FRONTEND_PID_FILE"))"
  else
    echo "[driver] 启动 Vite (port $FRONTEND_PORT) …"
    cd "$FRONTEND_DIR"
    nohup npx vite --port "$FRONTEND_PORT" --strictPort \
      > "$FRONTEND_LOG" 2>&1 &
    echo $! > "$FRONTEND_PID_FILE"
    echo "[driver] frontend pid=$(cat "$FRONTEND_PID_FILE")"
  fi
}

cmd_wait() {
  local elapsed=0
  echo "[driver] 等待 backend …"
  while ! _health_backend; do
    sleep 1; elapsed=$((elapsed + 1))
    if [ $elapsed -ge $WAIT_TIMEOUT ]; then
      echo "[driver] ERROR: backend 超时（${WAIT_TIMEOUT}s）"
      echo "--- backend log tail ---"
      tail -20 "$BACKEND_LOG" 2>/dev/null || true
      exit 1
    fi
  done
  echo "[driver] backend 就绪 (${elapsed}s)"

  elapsed=0
  echo "[driver] 等待 frontend …"
  while ! _health_frontend; do
    sleep 1; elapsed=$((elapsed + 1))
    if [ $elapsed -ge $WAIT_TIMEOUT ]; then
      echo "[driver] ERROR: frontend 超时（${WAIT_TIMEOUT}s）"
      echo "--- frontend log tail ---"
      tail -20 "$FRONTEND_LOG" 2>/dev/null || true
      exit 1
    fi
  done
  echo "[driver] frontend 就绪 (${elapsed}s)"

  echo "[driver] ✓ 前后端均已就绪"
  echo "  backend:  http://localhost:$BACKEND_PORT"
  echo "  frontend: http://localhost:$FRONTEND_PORT"
}

cmd_stop() {
  if [ -f "$BACKEND_PID_FILE" ]; then
    local pid
    pid=$(cat "$BACKEND_PID_FILE")
    if _is_pid_alive "$pid"; then
      echo "[driver] 停止 backend (pid $pid) …"
      kill "$pid" 2>/dev/null || true
      for _ in $(seq 1 50); do
        _is_pid_alive "$pid" || break
        sleep 0.1
      done
      _is_pid_alive "$pid" && kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$BACKEND_PID_FILE"
    echo "[driver] backend 已停止"
  else
    echo "[driver] backend 未在运行（无 PID 文件）"
  fi

  if [ -f "$FRONTEND_PID_FILE" ]; then
    local pid
    pid=$(cat "$FRONTEND_PID_FILE")
    if _is_pid_alive "$pid"; then
      echo "[driver] 停止 frontend (pid $pid) …"
      kill "$pid" 2>/dev/null || true
      for _ in $(seq 1 50); do
        _is_pid_alive "$pid" || break
        sleep 0.1
      done
      _is_pid_alive "$pid" && kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$FRONTEND_PID_FILE"
    echo "[driver] frontend 已停止"
  else
    echo "[driver] frontend 未在运行（无 PID 文件）"
  fi

  # 清理僵死子进程（Django runserver 会留子进程）
  pkill -f "manage.py runserver" 2>/dev/null || true
  pkill -f "vite.*--port $FRONTEND_PORT" 2>/dev/null || true
}

cmd_status() {
  echo "=== backend ==="
  if [ -f "$BACKEND_PID_FILE" ] && _is_pid_alive "$(cat "$BACKEND_PID_FILE")"; then
    echo "  状态: 运行中 (pid $(cat "$BACKEND_PID_FILE"))"
    _health_backend && echo "  健康检查: ✓ /api/health 200" || echo "  健康检查: ✗ /api/health 不可达"
  else
    echo "  状态: 未运行"
  fi

  echo "=== frontend ==="
  if [ -f "$FRONTEND_PID_FILE" ] && _is_pid_alive "$(cat "$FRONTEND_PID_FILE")"; then
    echo "  状态: 运行中 (pid $(cat "$FRONTEND_PID_FILE"))"
    _health_frontend && echo "  健康检查: ✓ http://localhost:$FRONTEND_PORT 200" || echo "  健康检查: ✗ 不可达"
  else
    echo "  状态: 未运行"
  fi
}

case "${1:-help}" in
  start)  cmd_start ;;
  stop)   cmd_stop ;;
  status) cmd_status ;;
  wait)   cmd_wait ;;
  restart) cmd_stop; sleep 1; cmd_start; cmd_wait ;;
  help|--help|-h)
    echo "用法: driver.sh {start|stop|restart|status|wait}"
    ;;
  *)
    echo "未知命令: $1"; exit 1 ;;
esac
