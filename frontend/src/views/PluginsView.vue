<script setup lang="ts">
// 插件目录页（#799 · #752 §4）：能力可见性唯一入口——目录 = 编译期清单经 GET /api/v1/plugins
// 渲染，启用位 = per-user 持久行（默认未启用，Q16；一键启用/禁用 = PUT enablement 幂等 upsert）。
// 禁用语义（Q12）：只影响新 run 装配——进行中 run 不中断（per-run 快照）、历史回放不受影响；
// 本页动作只触 REST，不触碰会话流。V1 目录仅 AutoFigure（#752 §4.1），页面按目录自然生长。
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { listPlugins, setPluginEnablement, type PluginSummary } from '@/api/plugins'

const plugins = ref<PluginSummary[]>([])
const loading = ref(true)
const pendingId = ref('')

onMounted(load)

async function load(): Promise<void> {
  loading.value = true
  try {
    plugins.value = await listPlugins()
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '插件目录加载失败')
  } finally {
    loading.value = false
  }
}

async function toggle(p: PluginSummary, enabled: boolean): Promise<void> {
  if (pendingId.value !== '') return
  pendingId.value = p.id
  try {
    await setPluginEnablement(p.id, enabled)
    p.enabled = enabled
    ElMessage.success(enabled ? `已启用 ${p.name}` : `已禁用 ${p.name}`)
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '操作失败') // 开关态不预改——失败自然回落
  } finally {
    pendingId.value = ''
  }
}
</script>

<template>
  <div class="plugins-view">
    <h2>插件</h2>
    <p class="intro">官方内置能力单元。默认未启用；启用后其工具与命令在本账号会话中可用，禁用不影响进行中的任务与历史记录。</p>
    <p v-if="loading" class="state">加载中…</p>
    <p v-else-if="plugins.length === 0" class="state" data-test="plugin-empty">暂无插件</p>
    <div
      v-for="p in plugins"
      v-else
      :key="p.id"
      class="plugin-card"
      data-test="plugin-card"
    >
      <div class="head">
        <div class="title">
          <strong>{{ p.name }}</strong>
          <span class="version">v{{ p.version }}</span>
        </div>
        <ElSwitch
          :model-value="p.enabled"
          :loading="pendingId === p.id"
          :disabled="pendingId !== ''"
          @change="(v: unknown) => toggle(p, v === true)"
        />
      </div>
      <p class="desc">{{ p.description }}</p>
      <div v-if="p.commands.length" class="commands">
        <span v-for="c in p.commands" :key="c.name" class="cmd" :title="c.description">/{{ c.name }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.plugins-view { max-width: 760px; margin: 0 auto; padding: 20px; }
.intro { color: var(--el-text-color-secondary); font-size: 13px; margin-top: -6px; }
.state { color: var(--el-text-color-secondary); }
.plugin-card { border: 1px solid var(--el-border-color); border-radius: 10px; padding: 14px 18px; margin-bottom: 12px; }
.head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.title { display: flex; align-items: baseline; gap: 8px; font-size: 15px; }
.version { color: var(--el-text-color-placeholder); font-size: 12px; }
.desc { margin: 6px 0 0; color: var(--el-text-color-regular); font-size: 13px; }
.commands { margin-top: 8px; display: flex; gap: 8px; flex-wrap: wrap; }
.cmd { font-family: ui-monospace, monospace; font-size: 12px; background: var(--el-fill-color); border: 1px solid var(--el-border-color); border-radius: 6px; padding: 1px 8px; }
</style>
