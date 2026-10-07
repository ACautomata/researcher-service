<script setup lang="ts">
// admin 端点白名单管理页（#800 ↔ /api/v1/provider-endpoints，#775 后端面）：
// 列表 + 新建 dialog（scheme/host/port/note）+ 删除（二次确认 + 引用提示——引用该端点的
// provider 不级联，下个 run 复验未命中 40042，后端双层校验兜底）。state 局部 ref 不开 store。
// 错误面：40041 冲突 / 90002 字段级（含 DNS 私网拒绝）经 ApiError.message 逐字 toast。
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  createProviderEndpoint,
  listProviderEndpoints,
  removeProviderEndpoint,
  type ProviderEndpointDTO,
} from '@/api/providerEndpoints'

const rows = ref<ProviderEndpointDTO[]>([])
const loading = ref(false)
const createVisible = ref(false)
const creating = ref(false)
const form = ref<{ scheme: string; host: string; port?: number; note: string }>({
  scheme: 'https',
  host: '',
  note: '',
})

async function refresh(): Promise<void> {
  loading.value = true
  try {
    rows.value = await listProviderEndpoints()
  } catch (e) {
    ElMessage.error((e as Error).message)
  } finally {
    loading.value = false
  }
}

function openCreate(): void {
  form.value = { scheme: 'https', host: '', note: '' }
  createVisible.value = true
}

async function submitCreate(): Promise<void> {
  if (!form.value.host.trim()) {
    ElMessage.warning('请填写 host')
    return
  }
  creating.value = true
  try {
    await createProviderEndpoint({
      scheme: form.value.scheme,
      host: form.value.host.trim(),
      ...(form.value.port !== undefined ? { port: form.value.port } : {}),
      ...(form.value.note.trim() ? { note: form.value.note.trim() } : {}),
    })
    createVisible.value = false
    await refresh()
    ElMessage.success('端点已加入白名单（下个 run 起生效）')
  } catch (e) {
    ElMessage.error((e as Error).message)
  } finally {
    creating.value = false
  }
}

async function removeRow(id: string): Promise<void> {
  try {
    await ElMessageBox.confirm(
      '删除后引用该端点的 model provider 将在下个 run 复验未命中（40042）。确认删除？',
      '删除白名单端点',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
  } catch {
    return // 用户取消
  }
  try {
    await removeProviderEndpoint(id)
    await refresh()
    ElMessage.success('端点已删除')
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

onMounted(refresh)

defineExpose({ rows, refresh, openCreate, submitCreate, removeRow, createVisible, form })
</script>

<template>
  <div class="admin-endpoints">
    <div class="header">
      <h1>端点白名单</h1>
      <el-button type="primary" data-test="open-create-endpoint" @click="openCreate">
        新建端点
      </el-button>
    </div>
    <p class="hint">
      model provider 的 base_url 须命中白名单（origin 精确匹配）方可运行；变更与 provider
      配置共用 config 版本号，下个 run 热生效。
    </p>

    <el-table :data="rows" v-loading="loading" data-test="endpoints-table">
      <el-table-column prop="scheme" label="scheme" width="90" />
      <el-table-column prop="host" label="host" min-width="220" />
      <el-table-column label="port" width="100">
        <template #default="{ row }">{{ row.port ?? '默认' }}</template>
      </el-table-column>
      <el-table-column prop="note" label="备注" min-width="140" />
      <el-table-column prop="created_by" label="创建人" width="120" />
      <el-table-column prop="created_at" label="创建时间" width="200" />
      <el-table-column label="操作" width="100">
        <template #default="{ row }">
          <el-button
            size="small"
            type="danger"
            :data-test="`remove-endpoint-${row.host}`"
            @click="removeRow(row.id)"
          >
            删除
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="createVisible" title="新建白名单端点" data-test="create-endpoint-dialog" width="440px">
      <el-form label-width="80px">
        <el-form-item label="scheme">
          <el-select v-model="form.scheme" data-test="new-endpoint-scheme">
            <el-option value="https" label="https（生产）" />
            <el-option value="http" label="http（仅开发）" />
          </el-select>
        </el-form-item>
        <el-form-item label="host">
          <el-input v-model="form.host" placeholder="api.example.com" data-test="new-endpoint-host" />
        </el-form-item>
        <el-form-item label="port">
          <el-input-number
            v-model="form.port"
            :min="1"
            :max="65535"
            :controls="false"
            placeholder="默认"
            data-test="new-endpoint-port"
          />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.note" placeholder="可选" data-test="new-endpoint-note" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button data-test="cancel-create-endpoint" @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="creating" data-test="submit-create-endpoint" @click="submitCreate">
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
.hint {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
</style>
