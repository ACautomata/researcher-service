<script setup lang="ts">
// #962 视觉定稿：A3 #929 变体 B「分组卡」——按 op 三节分组（空缺节跳过）+ 药丸徽标 +
// 目录 rtl-ellipsis 弱化 / 文件名 mono 主文本。行为契约承袭 #959 T1 / #960 T2 / #961 T3：
// props 形状、data-test 钩子、下载 IO 不变；行序 = 组序（created→modified→deleted）× 组内原序。
// 行形状 TurnFileRow（api/sessions.ts 镜像 server filejournal/turnFiles.ts）；下载走既有
// readAttachmentBlob 认证字节通道（JWT 在 Authorization 头，裸 <a href> 不可行——useAttachmentMedia
// download 同形态：blob URL + a[download]）。deleted 行恒无链接（无字节——D2 恢复语义归 rewind）。
import { computed } from 'vue'
import { ElMessage } from 'element-plus'
import type { TurnFileRow } from '@/api/sessions'
import { readAttachmentBlob } from '@/api/attachments'

const props = defineProps<{ files: TurnFileRow[]; filesTotal?: number; hasExec?: boolean }>()

const OP_ORDER = ['created', 'modified', 'deleted'] as const
type Op = (typeof OP_ORDER)[number]
const OP_LABEL: Record<Op, string> = { created: '新建', modified: '修改', deleted: '删除' }

// 头计数 = 截断前行数（filesTotal 缺省 = 列出数）；计数行 N = 总行数 - 列出数。
const total = computed(() => props.filesTotal ?? props.files.length)
const restCount = computed(() => Math.max(0, total.value - props.files.length))

// 分组视图模型（一次算好：节序固定、组内原序、行路径预拆分）。
// 同一文件一轮内可出现多行（两次修改各一条 journal 行）——:key 必须带组内序号。
interface GroupRow {
  row: TurnFileRow
  dir: string
  name: string
}
const groups = computed(() => {
  const counts: Record<Op, number> = { created: 0, modified: 0, deleted: 0 }
  for (const f of props.files) counts[f.op] += 1
  return OP_ORDER.filter((op) => counts[op] > 0).map((op) => ({
    op,
    label: OP_LABEL[op],
    count: counts[op],
    rows: props.files
      .filter((f) => f.op === op)
      .map((f): GroupRow => ({ row: f, ...splitPath(f.path) })),
  }))
})

// dir 不带尾斜杠——斜杠由模板独立渲染（rtl 省略块内中性字符会跳到对侧边界，折进 dir 文本
// 会渲染成 "/experimentsrun_014.py"——原型 A3 踩坑记录）。
function splitPath(path: string): { dir: string; name: string } {
  const idx = path.lastIndexOf('/')
  return idx < 0 ? { dir: '', name: path } : { dir: path.slice(0, idx), name: path.slice(idx + 1) }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function titleOf(row: TurnFileRow): string {
  return row.size != null ? `${row.path} · ${formatBytes(row.size)}` : row.path
}

async function download(row: TurnFileRow): Promise<void> {
  if (!row.attachmentId) return
  try {
    const blob = await readAttachmentBlob(row.attachmentId)
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = row.fileName || 'file'
    link.click()
    // 浏览器已接管下载——迟回收防 Safari 点击竞争（object URL 生命周期：下载完成后即无引用）
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  } catch (err) {
    console.warn(`[turn-files] 下载失败: ${row.path}`, err)
    ElMessage.error('下载失败')
  }
}
</script>

<template>
  <div v-if="files.length" class="turn-files" data-test="turn-files">
    <div class="tf-head" data-test="turn-files-head">
      <span class="tf-title">本轮产物</span>
      <span class="tf-count" data-test="turn-files-count">{{ total }} 个文件</span>
    </div>
    <section v-for="g in groups" :key="g.op" class="tf-group" :data-op="g.op" data-test="turn-files-group">
      <p class="tf-glabel" data-test="turn-files-glabel">{{ g.label }} · {{ g.count }}</p>
      <ul class="tf-rows">
        <li
          v-for="(r, idx) in g.rows"
          :key="`${r.row.path}-${idx}`"
          class="tf-row"
          data-test="turn-file-row"
          :data-op="r.row.op"
          :data-path="r.row.path"
        >
          <span class="tf-badge" data-test="turn-file-badge">{{ g.label }}</span>
          <span class="tf-path" data-test="turn-file-path" :title="titleOf(r.row)">
            <template v-if="r.dir">
              <span class="tf-dir" data-test="turn-file-dir">{{ r.dir }}</span><span class="tf-sep">/</span>
            </template><span class="tf-name" data-test="turn-file-name">{{ r.name }}</span>
          </span>
          <a
            v-if="r.row.op !== 'deleted' && r.row.attachmentId"
            class="tf-download"
            data-test="turn-file-download"
            @click.prevent="download(r.row)"
          >下载</a>
          <span v-else-if="r.row.op === 'deleted'" class="tf-deleted" data-test="turn-file-deleted">已删除</span>
        </li>
      </ul>
    </section>
    <div v-if="restCount > 0" class="tf-more" data-test="turn-files-more">等 {{ restCount }} 个文件</div>
    <!-- #961 exec 副作用动态提示（D6）：本轮含 EXEC_TOOLS 调用时卡底虚线一行——只断言「有调用」
         不断言「有写入」。 -->
    <div v-if="hasExec" class="tf-exec" data-test="turn-files-exec">本轮含 Shell 调用，其文件副作用不在此列</div>
  </div>
</template>

<style scoped>
/* 容器：tool-group 同族（A3 #929 定稿）——fill-color-light 底 + 1px 边框 + 9px 圆角 */
.turn-files {
  margin-top: 8px;
  padding: 8px 12px 9px;
  font-size: 12.5px;
  background: var(--el-fill-color-light);
  border: 1px solid var(--el-border-color);
  border-radius: 9px;
  min-width: 0;
}
.tf-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.tf-title { font-weight: 600; }
.tf-count { color: var(--el-text-color-secondary); font-size: 12px; }
.tf-group { margin-top: 6px; }
.tf-glabel { margin: 0 0 2px; color: var(--el-text-color-placeholder); font-size: 12px; }
.tf-rows { margin: 0; padding: 0; list-style: none; }
.tf-row { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 3px 0; }
/* 药丸徽标：新建绿 success / 修改蓝 primary / 删除灰 secondary——历史陈述不用 danger（D9） */
.tf-badge { flex: 0 0 auto; padding: 0 6px; border-radius: 8px; font-size: 11px; line-height: 17px; border: 1px solid; }
.tf-group[data-op='created'] .tf-badge { color: var(--el-color-success); border-color: var(--el-color-success-light-5); background: var(--el-color-success-light-9); }
.tf-group[data-op='modified'] .tf-badge { color: var(--el-color-primary); border-color: var(--el-color-primary-light-5); background: var(--el-color-primary-light-9); }
.tf-group[data-op='deleted'] .tf-badge { color: var(--el-text-color-secondary); border-color: var(--el-border-color); background: var(--el-fill-color); }
/* 路径：目录 rtl-ellipsis 弱化 + 文件名 mono 主文本（rtl 块吞中性字符坑——斜杠独立 span） */
.tf-path { min-width: 0; flex: 1; display: flex; overflow: hidden; }
.tf-dir { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--el-text-color-secondary); direction: rtl; }
.tf-sep { flex: 0 0 auto; color: var(--el-text-color-secondary); }
.tf-name { flex: 0 0 auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
/* 「下载」文字链：primary 色 + hover 下划线 */
.tf-download { flex: 0 0 auto; font-size: 12px; color: var(--el-color-primary); cursor: pointer; text-decoration: none; }
.tf-download:hover { text-decoration: underline; }
.tf-deleted { flex: 0 0 auto; font-size: 12px; color: var(--el-text-color-placeholder); }
.tf-more { margin: 6px 0 0; text-align: center; color: var(--el-text-color-placeholder); font-size: 12px; }
.tf-exec { margin: 6px 0 0; padding-top: 5px; border-top: 1px dashed var(--el-border-color); color: var(--el-text-color-placeholder); font-size: 12px; }
</style>
