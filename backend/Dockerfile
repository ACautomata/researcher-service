# backend/Dockerfile —— Django 6 + DRF + Channels(Daphne) 控制面生产镜像（issue #CD）
# 多阶段：builder 安装依赖到 venv（含编译工具链，cryptography 等需要），runtime 仅拷贝
# venv + 源码，保持镜像精简。容器启动经 entrypoint：先 migrate（prod settings，幂等）再起 daphne。

# ---- builder：编译/安装依赖到隔离 venv ----
FROM python:3.13-slim AS builder

# 编译 cryptography 等含 C 扩展的依赖所需；仅存在于 builder 阶段，不进 runtime。
RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc libffi-dev \
    && rm -rf /var/lib/apt/lists/*

ENV VENV=/opt/venv
RUN python -m venv "$VENV"
ENV PATH="$VENV/bin:$PATH"

# 仅拷贝依赖清单以最大化层缓存；源码变化不触发重装。
COPY requirements/base.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r /tmp/requirements.txt

# ---- runtime：精简运行镜像 ----
FROM python:3.13-slim

ENV VENV=/opt/venv
ENV PATH="$VENV/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    # asgi.py 已 setdefault prod；显式声明使 manage.py（默认 dev）与 daphne 行为一致。
    DJANGO_SETTINGS_MODULE=config.settings.prod

COPY --from=builder "$VENV" "$VENV"

WORKDIR /app
# 仅拷贝运行所需：Django 项目代码 + manage.py + entrypoint；测试/venv/缓存经 .dockerignore 排除。
COPY . /app

RUN chmod +x /app/docker-entrypoint.sh

EXPOSE 8000

ENTRYPOINT ["/app/docker-entrypoint.sh"]
