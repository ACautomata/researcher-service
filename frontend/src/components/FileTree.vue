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
        class="node"
        :class="{ active: p.path === activePath }"
        :data-test="`node-${p.path}`"
        @click="emit('open', p.path)"
      >
        <span class="node-title">{{ p.title }}</span>
        <button
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
  border-bottom: 1px solid var(--el-border-color);
}
.tree-title {
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.create-btn {
  border: none;
  background: none;
  font-size: 16px;
  cursor: pointer;
  color: var(--el-color-primary);
}
.group-name {
  padding: 6px 10px 2px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.node {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 4px 10px 4px 20px;
  cursor: pointer;
  color: var(--el-text-color-regular);
}
.node:hover {
  background: var(--el-fill-color-light);
}
.node.active {
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
}
.del-btn {
  border: none;
  background: none;
  cursor: pointer;
  color: var(--el-text-color-placeholder);
  visibility: hidden;
}
.node:hover .del-btn {
  visibility: visible;
}
.del-btn:hover {
  color: var(--el-color-danger);
}
</style>
