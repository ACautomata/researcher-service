# deploy/sandbox-image/Dockerfile —— 会话沙箱镜像 poppler 支路（#908 · 853 §3.2#2 镜像验收项）
#
# 形态：debian:bookworm-slim + poppler-utils——ctx.docs.extractPdfText 的镜像前提（核心固定
# pdftotext 命令、沙箱内执行；GLOSSARY 沙箱词条工具链已列 poppler）。#776 缺省 busybox 镜像
# 不含 pdftotext：本支路为科研工作流（W1/W2 extract，853 §4.1/§4.2）的启用面——部署以
# SANDBOX_IMAGE 指向本镜像即启用 extractPdfText；缺省翻转（完整工具链镜像）归沙箱镜像升级票
#（config.ts readSandboxImage 注记同口径，本票不翻缺省）。
#
# 与 wiki 镜像的版本约定差异（有意）：debian:bookworm-slim 是移动 tag，不适用「版本 tag =
# FROM 基线、一经发布不可移动」约定——CD 只推 :latest + :<sha> 两个 tag（部署钉版引用按
# sha tag）；sandboxImage.test.ts 只锁声明面不锁版本双源。
#
# 保留 busybox 缺省承载的最小 applet 断言集（sh/timeout/test/tail/mkdir/rm/cat——runner
# backend 超时 kill、保活 PID 1 与 /lab 预置的前提，dockerPrimitives.exec 注记同），任一
# 缺失即构建失败（不带病出镜像）。
#
# 构建：docker build -t ghcr.io/acautomata/researcher-service/sandbox:local deploy/sandbox-image

FROM debian:bookworm-slim

# poppler-utils 提供 pdftotext（PDF 文本提取 CLI）——apt 索引同层清掉不残留。
# 构建期双断言：command -v（安装路径在位）+ pdftotext -v（可执行面真实）——任一缺失构建失败。
RUN apt-get update \
    && apt-get install -y --no-install-recommends poppler-utils \
    && rm -rf /var/lib/apt/lists/* \
    && command -v pdftotext \
    && pdftotext -v

# busybox 缺省承载的最小 applet 集在位断言（对齐 deploy/wiki-image 构建期断言先例）。
RUN command -v sh \
    && command -v timeout \
    && command -v test \
    && command -v tail \
    && command -v mkdir \
    && command -v rm \
    && command -v cat
