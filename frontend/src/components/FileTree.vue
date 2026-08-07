<script setup lang="ts">
// FileTree —— wiki 文件树（issue #45 验收 1 + issue #83 物理化）：照实平铺磁盘真实目录分组，
// 组标签直接渲染 g.name（任意目录开放词表，不写死中文映射）。
// 点节点进编辑器（open），当前页高亮，新建/删除冒泡。
import type { WikiTreeGroupDTO } from '@/api/wiki'

defineProps<{ groups: WikiTreeGroupDTO[]; activePath: string }>()
const emit = defineEmits<{
  open: [path: string]
  create: []
  delete: [path: string]
}>()
</script>

<template>
  <div class="file-tree" data-test="file-tree">
    <div class="tree-header">
      <span class="tree-title">文件</span>
      <button data-test="create" class="create-btn" title="新建页面" @click="emit('create')">＋</button>
    </div>
    <div v-for="g in groups" :key="g.kind" class="group" :data-test="`group-${g.kind}`">
      <div class="group-name">{{ g.name }}</div>
      <div
        v-for="p in g.pages"
        :key="p.path"
        class="node-row"
        :class="{ active: p.path === activePath }"
      >
        <button
          type="button"
          class="node"
          :class="{ active: p.path === activePath }"
          :aria-current="p.path === activePath ? 'page' : undefined"
          :data-test="`node-${p.path}`"
          @click="emit('open', p.path)"
        >
          <span class="node-title">{{ p.title }}</span>
        </button>
        <button
          type="button"
          class="del-btn"
          :data-test="`delete-${p.path}`"
          title="删除页面"
          @click.stop="emit('delete', p.path)"
        >
          ×
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.file-tree {
  height: 100%;
  overflow-y: auto;
  font-size: 13px;
}
.tree-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 10px;
  border-bottom: 1px solid #e4e7ed;
}
.tree-title {
  font-weight: 600;
  color: #303133;
}
.create-btn {
  border: none;
  background: none;
  font-size: 16px;
  cursor: pointer;
  color: #409eff;
}
.group-name {
  padding: 6px 10px 2px;
  color: #909399;
  font-size: 12px;
}
.node-row {
  display: flex;
  align-items: center;
  color: #606266;
}
.node-row:hover,
.node-row:focus-within {
  background: #f5f7fa;
}
.node-row.active {
  background: #ecf5ff;
  color: #409eff;
}
.node {
  flex: 1;
  min-width: 0;
  padding: 4px 4px 4px 20px;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  text-align: left;
}
.node:focus-visible,
.del-btn:focus-visible {
  outline: 2px solid #409eff;
  outline-offset: -2px;
}
.del-btn {
  flex: none;
  margin-right: 8px;
  border: none;
  background: none;
  cursor: pointer;
  color: #c0c4cc;
  visibility: hidden;
}
.node-row:hover .del-btn,
.node-row:focus-within .del-btn {
  visibility: visible;
}
.del-btn:hover {
  color: #f56c6c;
}
@media (hover: none) {
  .del-btn {
    visibility: visible;
  }
}
</style>
