<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { listTraceLogs, type TraceLogRowDTO, type TraceStatus } from '@/api/traceLogs'

const logs = ref<TraceLogRowDTO[]>([])
const loading = ref(false)
const errorMsg = ref('')
const userId = ref('')
const ip = ref('')
const content = ref('')
const status = ref<TraceStatus | ''>('')
const page = ref(1)
const pageSize = ref(10)
const total = ref(0)

function shortHash(v: string): string {
  return v ? `${v.slice(0, 12)}...${v.slice(-8)}` : ''
}

function formatDate(v: string): string {
  if (!v) return ''
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString()
}

async function refresh(resetPage = false): Promise<void> {
  if (resetPage) page.value = 1
  loading.value = true
  errorMsg.value = ''
  try {
    const data = await listTraceLogs({
      userId: userId.value.trim(),
      ip: ip.value.trim(),
      content: content.value.trim(),
      status: status.value,
      page: page.value,
      pageSize: pageSize.value,
    })
    logs.value = data.logs
    total.value = data.total
    page.value = data.page
    pageSize.value = data.pageSize
  } catch (e) {
    errorMsg.value = (e as Error).message
    ElMessage.error(errorMsg.value)
  } finally {
    loading.value = false
  }
}

function clearFilters(): void {
  userId.value = ''
  ip.value = ''
  content.value = ''
  status.value = ''
  void refresh(true)
}

function onPageChange(next: number): void {
  page.value = next
  void refresh()
}

function onPageSizeChange(next: number): void {
  pageSize.value = next
  void refresh(true)
}

onMounted(() => refresh())

defineExpose({ refresh, clearFilters })
</script>

<template>
  <div class="trace-logs">
    <div class="header">
      <h1>内容消息</h1>
      <el-button :loading="loading" data-test="trace-refresh" @click="refresh()">刷新</el-button>
    </div>

    <div class="filters">
      <el-input v-model="userId" clearable placeholder="UserID" data-test="trace-user-id" @keyup.enter="refresh(true)" />
      <el-input v-model="ip" clearable placeholder="IP" data-test="trace-ip" @keyup.enter="refresh(true)" />
      <el-input v-model="content" clearable placeholder="内容 / 签名" data-test="trace-content" @keyup.enter="refresh(true)" />
      <el-select v-model="status" clearable placeholder="状态" data-test="trace-status">
        <el-option label="成功" value="success" />
        <el-option label="失败" value="failed" />
      </el-select>
      <el-button type="primary" data-test="trace-search" @click="refresh(true)">搜索</el-button>
      <el-button data-test="trace-clear" @click="clearFilters">重置</el-button>
    </div>

    <p v-if="errorMsg" class="error">{{ errorMsg }}</p>

    <el-table :data="logs" v-loading="loading" data-test="trace-table">
      <el-table-column prop="traceId" label="任务ID" min-width="180">
        <template #default="{ row }">
          <span class="mono" :title="row.traceId">{{ shortHash(row.traceId) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="触发用户" min-width="150">
        <template #default="{ row }">
          <div>{{ row.username }}</div>
          <div class="sub mono">{{ row.userId }}</div>
        </template>
      </el-table-column>
      <el-table-column prop="ipAddress" label="IP" min-width="130" />
      <el-table-column prop="inputText" label="输入的原始数据" min-width="260" show-overflow-tooltip />
      <el-table-column prop="outputText" label="输出的内容" min-width="300" show-overflow-tooltip />
      <el-table-column label="Hash" min-width="180">
        <template #default="{ row }">
          <span class="mono" :title="row.outputHash">{{ shortHash(row.outputHash) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="日期" min-width="170">
        <template #default="{ row }">{{ formatDate(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag :type="row.status === 'success' ? 'success' : 'danger'" size="small">
            {{ row.status === 'success' ? '成功' : '失败' }}
          </el-tag>
        </template>
      </el-table-column>
    </el-table>

    <div class="pager">
      <span class="total">共 {{ total }} 条</span>
      <el-pagination
        background
        layout="sizes, prev, pager, next"
        :current-page="page"
        :page-size="pageSize"
        :page-sizes="[10, 20, 50, 100]"
        :total="total"
        @current-change="onPageChange"
        @size-change="onPageSizeChange"
      />
    </div>
  </div>
</template>

<style scoped>
.trace-logs {
  padding: 20px;
}
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}
.filters {
  display: grid;
  grid-template-columns: minmax(140px, 1fr) minmax(120px, 1fr) minmax(180px, 1.4fr) 120px auto auto;
  gap: 10px;
  align-items: center;
  margin-bottom: 14px;
}
.error {
  color: var(--el-color-danger);
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.sub {
  margin-top: 3px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.pager {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 16px;
  padding-top: 14px;
}
.total {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
@media (max-width: 900px) {
  .filters {
    grid-template-columns: 1fr;
  }
  .pager {
    justify-content: flex-start;
    flex-wrap: wrap;
  }
}
</style>
