<script setup lang="ts">
// Read-only wiki: tree/graph navigation, OKF reader, independent update progress.
import { nextTick, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage } from 'element-plus'
import { listInstances } from '@/api/containers'
import { getGraph } from '@/api/wiki'
import type { WikiGraphDTO } from '@/api/wiki'
import { ApiError } from '@/api/errors'
import { useWikiStore } from '@/stores/wiki'
import { useAuthStore } from '@/stores/auth'
import { INLINE_RANGE_NARROW, INLINE_RANGE_WIDE } from '@/panels/triState'
import { usePanelGroup } from '@/panels/usePanelGroup'
import { usePanelTriState } from '@/panels/usePanelTriState'
import FileTree from '@/components/FileTree.vue'
import WikiPreview from '@/components/WikiPreview.vue'
import { useWikiUpdate } from '@/wiki/useWikiUpdate'
import WikiGraph from '@/components/WikiGraph.vue'
import PanelTriState from '@/components/PanelTriState.vue'

const store = useWikiStore()
const { current, groups, activePath, page, claims, claimsError, loading } = storeToRefs(store)

// #668：文件树三态（inline 拖宽 160–560px / collapsed 窄条 / popped 浮层）。
// 宽度按用户+页面+面板落 localStorage，collapsed/popped 态不持久化。
const auth = useAuthStore()
// #670：本页三态面板组（每页一个实例，非模块级单例）——成员收到 pop 时整组重算，
// 弹一个自动收回另一个（spec #667 US25）。互斥逻辑单一实现在 usePanelGroup。
const panelGroup = usePanelGroup()
// 沿用页面原 220px 固定宽（无存储值时的默认宽度，窄屏 disabled 态同样用它）
const FILE_TREE_DEFAULT_WIDTH = 220
const filePanel = usePanelTriState({
  view: 'wiki',
  panel: 'file-tree',
  side: 'left',
  inlineRange: INLINE_RANGE_NARROW,
  defaultInlineWidth: FILE_TREE_DEFAULT_WIDTH,
  token: () => auth.token,
  group: panelGroup,
})
const {
  state: panelState,
  inlineWidth,
  poppedVw,
  disabled: panelDisabled,
  viewportWidth,
  onCollapse,
  onPop,
  onExpand,
  onRestore,
  onResizeInline,
  onResizePopped,
  onDragEnd,
} = filePanel

// #670：图谱三态（inline 拖宽 240–720px / collapsed 窄条 / popped 浮层），贴右边。
// 沿用页面原 320px 固定宽；与文件树同组 → 任一弹出时另一个自动收回。
const GRAPH_DEFAULT_WIDTH = 320
const graphPanel = usePanelTriState({
  view: 'wiki',
  panel: 'graph',
  side: 'right',
  inlineRange: INLINE_RANGE_WIDE,
  defaultInlineWidth: GRAPH_DEFAULT_WIDTH,
  token: () => auth.token,
  group: panelGroup,
})
const {
  state: graphState,
  inlineWidth: graphInlineWidth,
  poppedVw: graphPoppedVw,
  disabled: graphDisabled,
  viewportWidth: graphViewportWidth,
  onCollapse: onGraphCollapse,
  onPop: onGraphPop,
  onExpand: onGraphExpand,
  onRestore: onGraphRestore,
  onResizeInline: onGraphResizeInline,
  onResizePopped: onGraphResizePopped,
  onDragEnd: onGraphDragEnd,
} = graphPanel

// #493: 错误二分（对齐 LoginView codex P2 惯用法）——仅「已解析的 API 错误」（信封/HTTP 语义，
// 如 20040 越权）逐字透传后端真实消息；其余（AbortError "Fetch is aborted" / TypeError "Load failed"
// 等浏览器原生网络/超时错误，非 ApiError）走本地化兜底，不把英文浏览器原文漏给用户。
function wikiErrorMessage(e: unknown, fallback: string): string {
  return e instanceof ApiError && e.message ? e.message : fallback
}

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

const preview = ref<InstanceType<typeof WikiPreview>>()
const update = useWikiUpdate(async () => {
  const container = current.value
  await store.loadTree(container)
  await refreshGraph()
  if (current.value === container && activePath.value) await store.openPage(activePath.value)
})
const { busy: updating, message: updateMessage, detail: updateDetail, connected: updateConnected } = update
async function onUpdate() {
  try { await update.start(current.value) }
  catch (e) { ElMessage.error(wikiErrorMessage(e, '更新启动失败，请重试')) }
}

async function selectContainer(name: string): Promise<void> {
  if (!name) return
  await store.resetForContainer(name)
  await refreshGraph()
}

async function onSwitch(name: string): Promise<void> {
  if (name === current.value) return
  try {
    await store.switchContainer(name)
    await refreshGraph()
  } catch (e) {
    ElMessage.error(wikiErrorMessage(e, '容器切换失败，请重试'))
  }
}

async function onOpen(path: string, anchor = ''): Promise<void> {
  try {
    await store.openPage(path)
    await nextTick()
    if (activePath.value === path && anchor) await preview.value?.scrollToAnchor(anchor)
  } catch (e) {
    ElMessage.error(wikiErrorMessage(e, '页面打开失败，请重试'))
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
    ElMessage.error(wikiErrorMessage(e, 'Wiki 加载失败，请重试'))
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
        :disabled="updating"
        @change="onSwitch(($event.target as HTMLSelectElement).value)"
      >
        <option v-for="c in containers" :key="c" :value="c">{{ c }}</option>
      </select>
      <button data-test="update-wiki" :disabled="!current || updating || !updateConnected" @click="onUpdate">{{ updating ? '更新中…' : updateConnected ? '更新 wiki' : '连接进度中…' }}</button>
      <span role="status" aria-live="polite" data-test="wiki-update-progress">{{ updateMessage }} {{ updateDetail }}</span>
      <button
        class="toggle-graph"
        data-test="toggle-graph"
        @click="graphOpen = !graphOpen"
      >
        {{ graphOpen ? '隐藏图谱' : '显示图谱' }}
      </button>
    </header>

    <div class="wiki-body">
      <PanelTriState
        :state="panelState"
        side="left"
        label="文件树"
        :disabled="panelDisabled"
        :inline-width="inlineWidth"
        :default-width="FILE_TREE_DEFAULT_WIDTH"
        :popped-vw="poppedVw"
        :viewport-width="viewportWidth"
        @collapse="onCollapse"
        @pop="onPop"
        @expand="onExpand"
        @restore="onRestore"
        @resize-inline="onResizeInline"
        @resize-popped="onResizePopped"
        @drag-end="onDragEnd"
      >
        <FileTree
          :groups="groups"
          :active-path="activePath"
          @open="onOpen"
        />
      </PanelTriState>

      <main class="center">
        <WikiPreview v-if="page" ref="preview" :page="page" :claims="claims" :claims-error="claimsError" :graph="graph" @open="onOpen" />
        <div v-else class="empty" data-test="empty">{{ loading ? '正在加载…' : activePath ? '页面加载失败，请重新选择' : '从左侧选择一个页面阅读' }}</div>
      </main>

      <!-- #670：图谱接入三态包装。graphOpen=false 时连包装一起不渲染（无幽灵手柄）。
           浮层态贴右缘（side="right"），拖宽/弹出后 WikiGraph 由 ResizeObserver 重新 fit。 -->
      <PanelTriState
        v-if="graphOpen"
        :state="graphState"
        side="right"
        label="图谱"
        :disabled="graphDisabled"
        :inline-width="graphInlineWidth"
        :default-width="GRAPH_DEFAULT_WIDTH"
        :popped-vw="graphPoppedVw"
        :viewport-width="graphViewportWidth"
        @collapse="onGraphCollapse"
        @pop="onGraphPop"
        @expand="onGraphExpand"
        @restore="onGraphRestore"
        @resize-inline="onGraphResizeInline"
        @resize-popped="onGraphResizePopped"
        @drag-end="onGraphDragEnd"
      >
        <WikiGraph :graph="graph" :active-path="activePath" @open="onOpen" />
      </PanelTriState>
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
/* FileTree stays unchanged; wiki writing belongs to the agent. */
.wiki-body :deep(.file-tree .create-btn),
.wiki-body :deep(.file-tree .del-btn) { display: none; }
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
.center {
  flex: 1;
  /* #668：min-width:0 放开 flex 默认 min-content 下限——面板拖到 560px 时阅读区收缩
     到剩余空间而不是把 .wiki-body 顶溢出（「中间阅读区不被挤没」的实现保障）。 */
  min-width: 0;
  overflow-y: auto;
  padding: 16px 24px;
}
/* 图谱原 .right 固定宽/边框已移除：宽度与贴边边框现由 PanelTriState 三态接管
   （inline 宽度可拖、collapsed 收窄条、popped 浮层），避免双重定宽与双边框。 */
.empty {
  color: var(--el-text-color-secondary);
  padding: 40px;
  text-align: center;
}
</style>
