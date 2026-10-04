# deploy/wiki-image/Dockerfile —— wiki 容器镜像（#784 · #747 E 节 wiki 列）
#
# 形态：busybox 级极简（~1MB）——sh/mkdir/rm/cat 等基础 applet，无任何运行时（无 Node/无网关/
# 无 openclaw）。**零初始化**：无骨架 COPY（现状 openclaw-image 的 wiki/workspace 骨架随 #784
# 对 wiki 容器废止）——/wiki 目录由控制面创建流程 putArchive 预置属主（uid 1000），内容归
# OpenWiki 工具按需生成（#737 G 节）；空 /wiki 是合法初态（wiki REST 空树降级）。
# 安全/资源面与镜像层无关，由创建面强制（wikiContainers/dockerRuntime buildWikiCreateOptions）：
# NetworkMode none 零出网、Memory 256MB / PidsLimit 128、非 root、CapDrop ALL、no-new-privileges。
#
# 版本 tag 约定（对齐 deploy/openclaw-image 先例，issue #695）：下面 FROM 行的基线 tag 是**唯一
# 版本源**——CD 从本行提取版本并推送镜像版本 tag（`:<基线 tag>`，与 :latest / :<sha> 并存，见
# .github/workflows/cd.yml）；控制面默认镜像（server/src/config.ts WIKI_IMAGE 默认值）与之同
# 版本，两处由 server/test/wikiImage.test.ts 交叉断言锁死（防双源漂移）。**版本 tag 一经发布
# 不可移动**——换内容（加 applet/换基线）须 bump 版本、不得原地覆盖同名 tag。
#
# 构建：docker build -t ghcr.io/acautomata/researcher-service/wiki:<基线 tag> deploy/wiki-image

FROM busybox:1.36

# 构建期断言：wiki 域依赖的最小 applet 集在位（保活 tail + 写面 mkdir/rm + runner backend
# 超时 kill 的 timeout 预留），任一缺失即构建失败（不带病出镜像）。
RUN command -v sh \
    && command -v tail \
    && command -v mkdir \
    && command -v rm \
    && command -v cat \
    && command -v test \
    && command -v timeout
