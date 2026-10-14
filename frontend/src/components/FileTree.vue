<script setup lang="ts">
// FileTree —— wiki 目录树（#45 验收 1 + #83 物理化 + #954：分组键 = frontmatter category
// 中文值，服务端归组沉底）。组标签照实渲染 g.name（中文 category 值，树面零目录名）+ 页数；
// 「未分类」默认折叠，当前页所在分组自动展开，组头可点击切换。
import { ref, watch } from 'vue'
import type { WikiTreeGroupDTO } from '@/api/wiki'
import { WIKI_UNCATEGORIZED } from '@/wiki/values'

const props = defineProps<{ groups: WikiTreeGroupDTO[]; activePath: string }>()
const emit = defineEmits<{
  open: [path: string]
  create: []
  delete: [path: string]
}>()

// 折叠态：显式点击覆盖优先；默认「未分类」折叠、其余展开；当前页落入自动展开。
// 自动展开是导航语义：activePath 落入某组时清该组覆盖——否则用户一次收起会永久击穿
// 「打开未分类页时该组自动展开」（spec §3.1）；收起表达只在本次停留期间有效。
const collapsedOverride = ref<Record<string, boolean>>({})
watch(() => props.activePath, (path) => {
  const host = props.groups.find((g) => g.pages.some((p) => p.path === path))
  if (host && collapsedOverride.value[host.kind] !== undefined) {
    const next = { ...collapsedOverride.value }
    delete next[host.kind]
    collapsedOverride.value = next
  }
})
function isExpanded(g: WikiTreeGroupDTO): boolean {
  const override = collapsedOverride.value[g.kind]
  if (override !== undefined) return !override
  return g.kind !== WIKI_UNCATEGORIZED || g.pages.some((p) => p.path === props.activePath)
}
function toggle(g: WikiTreeGroupDTO): void {
  collapsedOverride.value = { ...collapsedOverride.value, [g.kind]: isExpanded(g) }
}
</script>

<template>
  <div class="file-tree" data-test="file-tree">
    <div class="tree-header">
      <span class="tree-title">文件</span>
      <button data-test="create" class="create-btn" title="新建页面" @click="emit('create')">＋</button>
    </div>
    <div v-for="g in groups" :key="g.kind" class="group" :data-test="`group-${g.kind}`">
      <button
        type="button"
        class="group-name"
        :data-test="`group-toggle-${g.kind}`"
        :aria-expanded="isExpanded(g)"
        @click="toggle(g)"
      >
        <span class="caret" aria-hidden="true">{{ isExpanded(g) ? '▾' : '▸' }}</span>
        <span class="group-label">{{ g.name }}</span>
        <span class="group-count" :data-test="`group-count-${g.kind}`">({{ g.pages.length }})</span>
      </button>
      <template v-if="isExpanded(g)">
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
      </template>
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
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  padding: 6px 10px 2px;
  border: none;
  background: none;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  cursor: pointer;
  text-align: left;
}
.group-name:focus-visible {
  outline: 2px solid #409eff;
  outline-offset: -2px;
}
.group-label {
  font-weight: 600;
}
.group-count {
  color: var(--el-text-color-placeholder);
}
.node-row {
  display: flex;
  align-items: center;
  cursor: pointer;
  color: var(--el-text-color-regular);
}
.node-row:hover,
.node-row:focus-within {
  background: var(--el-fill-color-light);
}
.node-row.active {
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
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
  color: var(--el-text-color-placeholder);
  visibility: hidden;
}
.node-row:hover .del-btn,
.node-row:focus-within .del-btn {
  visibility: visible;
}
.del-btn:hover {
  color: var(--el-color-danger);
}
@media (hover: none) {
  .del-btn {
    visibility: visible;
  }
}
</style>
