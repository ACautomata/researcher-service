<script setup lang="ts">
// 容器管理页（spec §9.3）：列表 name/status/health/port/image + 新建 + 删除（默认连数据删）。
// codex R2 :78：挂载期间轮询列表（新起 gateway 由 unhealthy 转 healthy、容器被外部停止等
// 运行时状态变化方能及时反映）；卸载即清定时器，避免泄漏/对已卸载组件发请求。
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  createInstance,
  listInstances,
  removeInstance,
  type InstanceDTO,
} from '@/api/containers'
import { ApiError } from '@/api/client'

const instances = ref<InstanceDTO[]>([])
const loading = ref(false)
const errorMsg = ref('')

// 新建对话框
const createVisible = ref(false)
const newName = ref('')
const creating = ref(false)

// codex R2 :78：轮询间隔（3s），对齐前端既有轮询节奏；太短打满健康探测，太长状态滞后
const POLL_INTERVAL_MS = 3000
let pollTimer: ReturnType<typeof setInterval> | null = null
// codex R3 :89：在飞请求标记——一次 list 超过 3s（多个不可达实例串行 2s 健康探测）时
// 跳过下一 tick，避免叠加并发 Docker/health 请求、乱序完成覆盖较新状态。
let refreshInFlight = false

async function refresh(): Promise<void> {
  if (refreshInFlight) return // codex R3 :89：上一次未完成则跳过本次
  refreshInFlight = true
  loading.value = true
  errorMsg.value = ''
  try {
    instances.value = await listInstances()
  } catch (e) {
    errorMsg.value = (e as Error).message
  } finally {
    loading.value = false
    refreshInFlight = false
  }
}

function openCreate(): void {
  newName.value = ''
  createVisible.value = true
}

async function submitCreate(): Promise<void> {
  if (!newName.value.trim()) {
    ElMessage.warning('请填写容器名称')
    return
  }
  creating.value = true
  try {
    await createInstance(newName.value.trim())
    createVisible.value = false
    await refresh()
    ElMessage.success('容器已创建')
  } catch (e) {
    ElMessage.error((e as Error).message)
  } finally {
    creating.value = false
  }
}

async function confirmRemove(name: string): Promise<void> {
  // spec §5.4：删除默认连数据删（wiki/配置），故需二次确认
  try {
    await ElMessageBox.confirm(
      `确认删除容器 ${name}？将一并清除其数据（wiki / openclaw.json）。`,
      '删除容器',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
  } catch {
    return // 用户取消
  }
  try {
    await removeInstance(name)
    await refresh()
    ElMessage.success('容器已删除')
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return // 401 已由 client 处理会话
    ElMessage.error((e as Error).message)
  }
}

onMounted(() => {
  void refresh()
  // codex R2 :78：周期性刷新，反映 runtime 状态/健康变化
  pollTimer = setInterval(() => {
    void refresh()
  }, POLL_INTERVAL_MS)
})

onBeforeUnmount(() => {
  if (pollTimer !== null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
})

// 暴露删除动作：el-table row slot 在测试 stub 下不便点击，暴露供测试与潜在父组件触发
defineExpose({ confirmRemove })
</script>

<template>
  <div class="containers">
    <div class="header">
      <h1>容器管理</h1>
      <el-button type="primary" data-test="open-create" @click="openCreate">新建容器</el-button>
    </div>
    <p v-if="errorMsg" class="error">{{ errorMsg }}</p>

    <el-table :data="instances" data-test="instance-table">
      <el-table-column prop="name" label="名称" />
      <el-table-column prop="status" label="状态" width="100" />
      <el-table-column prop="health" label="健康" width="100" />
      <el-table-column prop="port" label="端口" width="80" />
      <el-table-column prop="image" label="镜像" />
      <el-table-column label="操作" width="220">
        <template #default="{ row }">
          <el-button
            type="danger"
            size="small"
            :data-test="`delete-${row.name}`"
            @click="confirmRemove(row.name)"
          >
            删除
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="createVisible" title="新建容器" data-test="create-dialog" width="420px">
      <el-form>
        <el-form-item label="名称">
          <el-input
            v-model="newName"
            placeholder="小写字母开头，3–30 位，仅 a-z 0-9 -"
            data-test="name-input"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button data-test="cancel-create" @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="creating" data-test="submit-create" @click="submitCreate">
          创建
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.error {
  color: var(--el-color-danger);
}
</style>
