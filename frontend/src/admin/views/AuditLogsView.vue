<script setup lang="ts">
// admin 全局审计检索页（#800）：审批日志（approval-logs，#783）/ 覆盖日志
// （file-overwrite-logs，#785）双 tab + 过滤 + 分页。judge 输入只露 hash（后端契约）。
// state 局部 ref；tab 切换不清过滤（各 tab 过滤字段独立渲染、互不可见），
// 切 tab 自动重查该 tab 第 1 页（分页态不跨 tab 漂移）。
import { onMounted, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import {
  listApprovalLogs,
  listFileOverwriteLogs,
  type ApprovalLogRowDTO,
  type FileOverwriteLogRowDTO,
} from '@/api/audit'

const activeTab = ref<'approval' | 'overwrite'>('approval')
const loading = ref(false)
const page = ref(1)
const pageSize = ref(50)
const approval = ref<{ total: number; items: ApprovalLogRowDTO[] }>({ total: 0, items: [] })
const overwrite = ref<{ total: number; items: FileOverwriteLogRowDTO[] }>({ total: 0, items: [] })

// 审批过滤（layer/decision/runId/userId/时间窗）；覆盖过滤（sessionId/path/时间窗）
const filters = reactive<{
  layer?: string
  decision?: string
  runId: string
  userId: string
  sessionId: string
  path: string
  range: [Date, Date] | null
}>({ layer: undefined, decision: undefined, runId: '', userId: '', sessionId: '', path: '', range: null })

const rangeDates = (): { from?: Date; to?: Date } =>
  filters.range ? { from: filters.range[0], to: filters.range[1] } : {}

// 当前 tab 的一次查询（search 与 goPage 共此单一实现——差别仅在 page 值）。
// 快速连续查询的竞态守卫：仅最新一次请求可写回 state / 复位 loading / 弹错误——慢的旧响应
// 晚到直接丢弃（切 tab 分支在 await 前定型，旧响应本就不跨 tab 污染）。
let querySeq = 0
async function queryOnce(targetPage: number): Promise<void> {
  const seq = ++querySeq
  loading.value = true
  try {
    if (activeTab.value === 'approval') {
      const d = await listApprovalLogs({
        ...(filters.userId.trim() ? { userId: filters.userId.trim() } : {}),
        ...(filters.runId.trim() ? { runId: filters.runId.trim() } : {}),
        ...(filters.layer ? { layer: filters.layer as 'rule' | 'judge' | 'human' } : {}),
        ...(filters.decision ? { decision: filters.decision as 'allow' | 'deny' } : {}),
        ...rangeDates(),
        page: targetPage,
        pageSize: pageSize.value,
      })
      if (seq !== querySeq) return
      approval.value = { total: d.total, items: d.items }
    } else {
      const d = await listFileOverwriteLogs({
        ...(filters.sessionId.trim() ? { sessionId: filters.sessionId.trim() } : {}),
        ...(filters.path.trim() ? { path: filters.path.trim() } : {}),
        ...rangeDates(),
        page: targetPage,
        pageSize: pageSize.value,
      })
      if (seq !== querySeq) return
      overwrite.value = { total: d.total, items: d.items }
    }
  } catch (e) {
    if (seq !== querySeq) return
    ElMessage.error((e as Error).message)
  } finally {
    if (seq === querySeq) loading.value = false
  }
}

async function search(): Promise<void> {
  page.value = 1 // 新过滤恒从第 1 页起
  await queryOnce(1)
}

async function goPage(p: number): Promise<void> {
  page.value = p
  await queryOnce(p)
}

watch(activeTab, () => {
  page.value = 1
  void queryOnce(1)
})

onMounted(search)

defineExpose({ activeTab, filters, page, approval, overwrite, search, goPage })
</script>

<template>
  <div class="admin-audit">
    <div class="header"><h1>审计检索</h1></div>

    <el-form inline @submit.prevent="search">
      <template v-if="activeTab === 'approval'">
        <el-form-item label="层级">
          <el-select v-model="filters.layer" placeholder="全部" clearable style="width: 110px" data-test="filter-layer">
            <el-option value="rule" label="rule" />
            <el-option value="judge" label="judge" />
            <el-option value="human" label="human" />
          </el-select>
        </el-form-item>
        <el-form-item label="判定">
          <el-select v-model="filters.decision" placeholder="全部" clearable style="width: 110px" data-test="filter-decision">
            <el-option value="allow" label="allow" />
            <el-option value="deny" label="deny" />
          </el-select>
        </el-form-item>
        <el-form-item label="userId">
          <el-input v-model="filters.userId" placeholder="精确" style="width: 160px" data-test="filter-user-id" />
        </el-form-item>
        <el-form-item label="runId">
          <el-input v-model="filters.runId" placeholder="精确" style="width: 160px" data-test="filter-run-id" />
        </el-form-item>
      </template>
      <template v-else>
        <el-form-item label="sessionId">
          <el-input v-model="filters.sessionId" placeholder="精确" style="width: 200px" data-test="filter-session-id" />
        </el-form-item>
        <el-form-item label="path">
          <el-input v-model="filters.path" placeholder="wiki 相对路径" style="width: 200px" data-test="filter-path" />
        </el-form-item>
      </template>
      <el-form-item label="时间窗">
        <el-date-picker
          v-model="filters.range"
          type="daterange"
          start-placeholder="from（含）"
          end-placeholder="to（不含）"
          data-test="filter-range"
        />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" native-type="submit" :loading="loading" data-test="audit-search" @click="search">
          查询
        </el-button>
      </el-form-item>
    </el-form>

    <el-tabs v-model="activeTab" data-test="audit-tabs">
      <el-tab-pane name="approval" label="审批日志">
        <el-table :data="approval.items" v-loading="loading" data-test="approval-table">
          <el-table-column prop="created_at" label="时间" width="200" />
          <el-table-column prop="user_id" label="userId" width="120" />
          <el-table-column prop="layer" label="层级" width="80" />
          <el-table-column prop="decision" label="判定" width="80" />
          <el-table-column prop="tool_name" label="工具" width="130" />
          <el-table-column prop="policy_class" label="政策类" width="150" />
          <el-table-column prop="reason" label="理由" min-width="160" show-overflow-tooltip />
          <el-table-column prop="judge_input_hash" label="judge 输入 hash" min-width="140" show-overflow-tooltip />
          <el-table-column prop="run_id" label="runId" width="120" />
        </el-table>
        <el-pagination
          :total="approval.total"
          :page-size="pageSize"
          :current-page="page"
          layout="total, prev, pager, next"
          data-test="approval-pagination"
          @current-change="goPage"
        />
      </el-tab-pane>
      <el-tab-pane name="overwrite" label="覆盖日志">
        <el-table :data="overwrite.items" v-loading="loading" data-test="overwrite-table">
          <el-table-column prop="created_at" label="时间" width="200" />
          <el-table-column prop="session_id" label="sessionId" width="120" />
          <el-table-column prop="path" label="路径" min-width="220" show-overflow-tooltip />
          <el-table-column prop="overwriter_thread_id" label="覆盖者 thread" min-width="140" show-overflow-tooltip />
          <el-table-column prop="overwritten_thread_id" label="被覆盖者 thread" min-width="140" show-overflow-tooltip />
          <el-table-column prop="run_id" label="runId" width="120" />
        </el-table>
        <el-pagination
          :total="overwrite.total"
          :page-size="pageSize"
          :current-page="page"
          layout="total, prev, pager, next"
          data-test="overwrite-pagination"
          @current-change="goPage"
        />
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<style scoped>
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
</style>
