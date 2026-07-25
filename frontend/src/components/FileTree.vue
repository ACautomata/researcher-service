<script setup lang="ts">
// FileTree —— wiki 文件树（issue #45 验收 1）：五核心分类 + domains 子树分组渲染，
// 点节点进编辑器（open），当前页高亮，新建/删除冒泡。
import type { WikiTreeGroupDTO } from '@/api/wiki'

defineProps<{ groups: WikiTreeGroupDTO[]; activePath: string }>()
const emit = defineEmits<{
  open: [path: string]
  create: []
  delete: [path: string]
}>()

// 分组中文名（五核心分类 + domains 子树）
const KIND_LABELS: Record<string, string> = {
  concept: '概念',
  entity: '实体',
  source: '来源',
  synthesis: '综述',
  report: '报告',
  domain: '领域',
}
</script>

<template>
  <div class="file-tree" data-test="file-tree">
    <div class="tree-header">
      <span class="tree-title">文件</span>
      <button data-test="create" class="create-btn" title="新建页面" @click="emit('create')">＋</button>
    </div>
    <div v-for="g in groups" :key="g.kind" class="group" :data-test="`group-${g.kind}`">
      <div class="group-name">{{ KIND_LABELS[g.kind] ?? g.name }}</div>
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
.node {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 4px 10px 4px 20px;
  cursor: pointer;
  color: #606266;
}
.node:hover {
  background: #f5f7fa;
}
.node.active {
  background: #ecf5ff;
  color: #409eff;
}
.del-btn {
  border: none;
  background: none;
  cursor: pointer;
  color: #c0c4cc;
  visibility: hidden;
}
.node:hover .del-btn {
  visibility: visible;
}
.del-btn:hover {
  color: #f56c6c;
}
</style>
