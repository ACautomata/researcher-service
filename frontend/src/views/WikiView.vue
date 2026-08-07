<script setup lang="ts">
// WikiView —— wiki 编辑页（spec §9.6 / issue #45）。
// 版面：顶部容器切换器 + 左文件树 + 中 Milkdown 编辑器 + 右图谱（可折叠）。
// 联动：点树/图谱节点 openPage；编辑器 update → store.edit（防抖自动保存落盘）；
// 顶部切换容器 → store.switchContainer（切前自动落盘）。新建/删除经 store，落盘并触发 compile。
import { onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage, ElMessageBox } from 'element-plus'
import { listInstances } from '@/api/containers'
import { getGraph } from '@/api/wiki'
import type { WikiGraphDTO } from '@/api/wiki'
import { useWikiStore } from '@/stores/wiki'
import FileTree from '@/components/FileTree.vue'
import MdEditor from '@/components/MdEditor.vue'
import WikiGraph from '@/components/WikiGraph.vue'

const store = useWikiStore()
const { current, groups, activePath, draft, dirty, saving, saveSeq } = storeToRefs(store)

const containers = ref<string[]>([])
const graph = ref<WikiGraphDTO>({ nodes: [], edges: [] })
const graphOpen = ref(true)
let graphRequestSeq = 0

async function refreshGraph(): Promise<void> {
  const requestSeq = ++graphRequestSeq
  const container = current.value
  if (!container) {
    graph.value = { nodes: [], edges: [] }
    return
  }
  try {
    const nextGraph = await getGraph(container)
    if (requestSeq === graphRequestSeq && current.value === container) {
      graph.value = nextGraph
    }
  } catch {
    if (requestSeq === graphRequestSeq && current.value === container) {
      graph.value = { nodes: [], edges: [] }
    }
  }
}

// 自动保存成功后刷新树与图谱（codex PR #62 意见6）：title/wikilink 变更即时反映。
watch(saveSeq, async () => {
  await store.loadTree(current.value)
  await refreshGraph()
})

async function selectContainer(name: string): Promise<void> {
  if (!name) return
  // 初始化/重挂载：经 resetForContainer 清掉 Pinia 残留的旧编辑器态（codex PR #62 意见3），
  // 否则旧容器 draft 会在新容器下显示/被误覆盖写。
  await store.resetForContainer(name)
  await refreshGraph()
}

async function onSwitch(name: string): Promise<void> {
  if (name === current.value) return
  try {
    await store.switchContainer(name)
    await refreshGraph()
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

async function onOpen(path: string): Promise<void> {
  try {
    await store.openPage(path)
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

function onEdit(markdown: string): void {
  store.edit(markdown)
}

async function onCreate(): Promise<void> {
  let path = ''
  try {
    const { value } = await ElMessageBox.prompt(
      '相对 wiki/main 的路径（如 concepts/foo.md）',
      '新建页面',
      { confirmButtonText: '新建', cancelButtonText: '取消', inputPattern: /\.md$/,
        inputErrorMessage: '须以 .md 结尾' },
    )
    path = (value ?? '').trim()
  } catch {
    return // 用户取消
  }
  if (!path) return
  try {
    await store.createPage(path, `---\ntitle: ${path}\n---\n\n`)
    await refreshGraph()
    await store.openPage(path)
    ElMessage.success('页面已创建')
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

async function onDelete(path: string): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认删除页面 ${path}？`, '删除页面',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' })
  } catch {
    return
  }
  try {
    await store.deletePage(path)
    await refreshGraph()
    ElMessage.success('页面已删除')
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

onMounted(async () => {
  try {
    const list = await listInstances()
    containers.value = list.map((i) => i.name)
    if (containers.value.length > 0) {
      await selectContainer(containers.value[0])
    }
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
})
</script>

<template>
  <div class="wiki-view">
    <header class="wiki-header">
      <span class="brand">Wiki</span>
      <select
        data-test="container-switch"
        class="switcher"
        :value="current"
        @change="onSwitch(($event.target as HTMLSelectElement).value)"
      >
        <option v-for="c in containers" :key="c" :value="c">{{ c }}</option>
      </select>
      <span v-if="saving" class="save-state" data-test="saving">保存中…</span>
      <span v-else-if="dirty" class="save-state dirty" data-test="dirty">未保存</span>
      <span v-else class="save-state" data-test="saved">已保存</span>
      <button
        class="toggle-graph"
        data-test="toggle-graph"
        @click="graphOpen = !graphOpen"
      >
        {{ graphOpen ? '隐藏图谱' : '显示图谱' }}
      </button>
    </header>

    <div class="wiki-body">
      <aside class="left">
        <FileTree
          :groups="groups"
          :active-path="activePath"
          @open="onOpen"
          @create="onCreate"
          @delete="onDelete"
        />
      </aside>

      <main class="center">
        <MdEditor v-if="activePath" :content="draft" @update="onEdit" />
        <div v-else class="empty" data-test="empty">从左侧选择或新建一个页面开始编辑</div>
      </main>

      <aside v-if="graphOpen" class="right">
        <WikiGraph :graph="graph" :active-path="activePath" @open="onOpen" />
      </aside>
    </div>
  </div>
</template>

<style scoped>
.wiki-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.wiki-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--el-border-color);
}
.brand {
  font-weight: 600;
}
.switcher {
  padding: 4px 8px;
  border: 1px solid var(--el-border-color);
  border-radius: 4px;
  color: var(--el-text-color-regular);
  background: var(--el-bg-color);
}
.save-state {
  font-size: 12px;
  color: var(--el-color-success);
}
.save-state.dirty {
  color: var(--el-color-warning);
}
.toggle-graph {
  margin-left: auto;
  padding: 4px 10px;
  border: 1px solid var(--el-border-color);
  border-radius: 4px;
  color: var(--el-text-color-regular);
  background: var(--el-bg-color);
  cursor: pointer;
}
.wiki-body {
  display: flex;
  flex: 1;
  min-height: 0;
}
.left {
  width: 220px;
  border-right: 1px solid var(--el-border-color);
  overflow-y: auto;
}
.center {
  flex: 1;
  overflow-y: auto;
  padding: 16px 24px;
}
.right {
  width: 320px;
  border-left: 1px solid var(--el-border-color);
}
.empty {
  color: var(--el-text-color-secondary);
  padding: 40px;
  text-align: center;
}
</style>
