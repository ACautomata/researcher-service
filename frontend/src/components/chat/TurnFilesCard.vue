<script setup lang="ts">
// #959 轮次产物卡片（T1 朴素面——视觉定稿归 T4/#962）+ #960 T2：下载链接 / 删除行无链接 /
// >20 截断计数行。产物非轨迹——由 ChatMessageItem 挂媒体列表之后、ai-notice 之前（折叠条外）。
// 行形状 TurnFileRow（api/sessions.ts 镜像 server filejournal/turnFiles.ts）；下载走既有
// readAttachmentBlob 认证字节通道（JWT 在 Authorization 头，裸 <a href> 不可行——useAttachmentMedia
// download 同形态：blob URL + a[download]）。deleted 行恒无链接（无字节——D2 恢复语义归 rewind）。
import { computed } from 'vue'
import { ElMessage } from 'element-plus'
import type { TurnFileRow } from '@/api/sessions'
import { readAttachmentBlob } from '@/api/attachments'

const props = defineProps<{ files: TurnFileRow[]; filesTotal?: number }>()

const OP_LABEL: Record<TurnFileRow['op'], string> = { created: '新建', modified: '修改', deleted: '删除' }

// 头计数 = 截断前行数（filesTotal 缺省 = 列出数）；计数行 N = 总行数 - 列出数。
const total = computed(() => props.filesTotal ?? props.files.length)
const restCount = computed(() => Math.max(0, total.value - props.files.length))

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
      <span>本轮产物</span>
      <span class="tf-count" data-test="turn-files-count">{{ total }} 个文件</span>
    </div>
    <div v-for="(f, i) in files" :key="`${f.path}-${i}`" class="tf-row" data-test="turn-file-row" :data-op="f.op">
      <span class="tf-op">{{ OP_LABEL[f.op] }}</span>
      <span class="tf-path">{{ f.path }}</span>
      <a
        v-if="f.op !== 'deleted' && f.attachmentId"
        class="tf-download"
        data-test="turn-file-download"
        @click.prevent="download(f)"
      >下载</a>
      <span v-else-if="f.op === 'deleted'" class="tf-deleted" data-test="turn-file-deleted">已删除</span>
    </div>
    <div v-if="restCount > 0" class="tf-more" data-test="turn-files-more">等 {{ restCount }} 个文件</div>
  </div>
</template>

<style scoped>
.turn-files {
  margin-top: 8px;
  background: var(--el-fill-color-light);
  border: 1px solid var(--el-border-color);
  border-radius: 9px;
  padding: 6px 12px;
  font-size: 12.5px;
  min-width: 0;
}
.tf-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.tf-count { color: var(--el-text-color-placeholder); font-size: 12px; }
.tf-row { display: flex; align-items: center; gap: 8px; padding: 3px 0; min-width: 0; }
.tf-op { flex: 0 0 auto; color: var(--el-text-color-secondary); }
.tf-path {
  font-family: var(--el-font-family-mono, monospace);
  overflow-wrap: anywhere;
  color: var(--el-text-color-primary);
  flex: 1 1 auto;
  min-width: 0;
}
/* 「下载」文字链：primary 色 + hover 下划线（朴素面；药丸徽标/rtl-ellipsis 定稿归 T4） */
.tf-download {
  flex: 0 0 auto;
  color: var(--el-color-primary);
  cursor: pointer;
  text-decoration: none;
}
.tf-download:hover { text-decoration: underline; }
.tf-deleted { flex: 0 0 auto; color: var(--el-text-color-placeholder); }
.tf-more {
  padding: 3px 0;
  text-align: center;
  color: var(--el-text-color-placeholder);
  font-size: 12px;
}
</style>
