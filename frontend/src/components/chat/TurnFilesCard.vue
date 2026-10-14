<script setup lang="ts">
// #959 轮次产物卡片（T1 朴素面——视觉定稿归 T4/#962）：本轮新建/修改/删除的沙箱 /lab 文件
// 逐行列出。产物非轨迹——由 ChatMessageItem 挂媒体列表之后、ai-notice 之前（折叠条外）。
// 行形状 TurnFileRow（api/sessions.ts 镜像 server filejournal/turnFiles.ts）；下载链接归
// T2（#960）物化回填后补，删除行恒无链接。
import type { TurnFileRow } from '@/api/sessions'

defineProps<{ files: TurnFileRow[] }>()

const OP_LABEL: Record<TurnFileRow['op'], string> = { created: '新建', modified: '修改', deleted: '删除' }
</script>

<template>
  <div v-if="files.length" class="turn-files" data-test="turn-files">
    <div class="tf-head" data-test="turn-files-head">
      <span>本轮产物</span>
      <span class="tf-count" data-test="turn-files-count">{{ files.length }} 个文件</span>
    </div>
    <div v-for="(f, i) in files" :key="`${f.path}-${i}`" class="tf-row" data-test="turn-file-row" :data-op="f.op">
      <span class="tf-op">{{ OP_LABEL[f.op] }}</span>
      <span class="tf-path">{{ f.path }}</span>
    </div>
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
}
</style>
