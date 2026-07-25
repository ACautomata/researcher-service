<script setup lang="ts">
// Model 配置页（spec §9.5 / issue #47）：当前容器 selector + provider 列表 + 新增/编辑/删除表单。
// 写后后端重渲染该容器 openclaw.json，经 OpenClaw watch 热加载生效（无需重启，#36 已证）。
// apiKey 仅 env id（marker），绝不收集/回显明文。api 取值 openai-completions / anthropic-messages。
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { listInstances, type InstanceDTO } from '@/api/containers'
import { ApiError } from '@/api/client'
import {
  createProvider,
  listProviders,
  removeProvider,
  updateProvider,
  type ModelApi,
  type ModelEntryDTO,
  type ModelProviderDTO,
  type ModelProviderWriteDTO,
} from '@/api/models'

const containers = ref<InstanceDTO[]>([])
const current = ref<string>('')
const providers = ref<ModelProviderDTO[]>([])
const loading = ref(false)
const errorMsg = ref('')

// 新增/编辑对话框（共用一表单）
const dialogVisible = ref(false)
const editingPid = ref<string | null>(null)   // null = 新建；非空 = 编辑该 pid
const saving = ref(false)
const providerId = ref('')
const api = ref<ModelApi>('openai-completions')
const baseUrl = ref('')
const apiKeyEnvId = ref('')
const authHeader = ref(true)
const models = ref<ModelEntryDTO[]>([])

async function loadContainers(): Promise<void> {
  loading.value = true
  errorMsg.value = ''
  try {
    containers.value = await listInstances()
    if (!current.value && containers.value.length) {
      current.value = containers.value[0].name
    }
    if (current.value) {
      await loadProviders()
    }
  } catch (e) {
    errorMsg.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

async function loadProviders(): Promise<void> {
  if (!current.value) {
    providers.value = []
    return
  }
  try {
    providers.value = await listProviders(current.value)
  } catch (e) {
    errorMsg.value = (e as Error).message
    providers.value = []
  }
}

async function selectContainer(name: string): Promise<void> {
  current.value = name
  await loadProviders()
}

function resetForm(): void {
  providerId.value = ''
  api.value = 'openai-completions'
  baseUrl.value = ''
  apiKeyEnvId.value = 'LLM_API_KEY'   // spec §5.2：面板共享单一 LLM_API_KEY（容器仅注入它）
  authHeader.value = true
  models.value = [{ id: '', name: '' }]
  editingPid.value = null
}

function openCreate(): void {
  resetForm()
  dialogVisible.value = true
}

function openEdit(p: ModelProviderDTO): void {
  editingPid.value = p.provider_id
  providerId.value = p.provider_id
  api.value = p.api
  baseUrl.value = p.base_url
  apiKeyEnvId.value = p.api_key_env_id
  authHeader.value = p.auth_header
  models.value = (p.models ?? []).map((m) => ({ ...m }))
  if (!models.value.length) models.value = [{ id: '', name: '' }]
  dialogVisible.value = true
}

function addModel(): void {
  models.value.push({ id: '', name: '' })
}

function removeModel(idx: number): void {
  models.value.splice(idx, 1)
}

async function save(payload: ModelProviderWriteDTO): Promise<void> {
  // 测试 seam 允许直接传 payload；UI 提交时从表单 ref 组装。零信任：前端也校验必填。
  if (!payload.provider_id.trim() || !payload.base_url.trim() || !payload.api_key_env_id.trim()) {
    ElMessage.warning('provider_id / baseUrl / apiKey env id 不能为空')
    return
  }
  if (!payload.models.length || !payload.models[0].id.trim()) {
    ElMessage.warning('至少一条 model 且需含 id')
    return
  }
  saving.value = true
  try {
    if (editingPid.value) {
      await updateProvider(current.value, editingPid.value, payload)
    } else {
      await createProvider(current.value, payload)
    }
    dialogVisible.value = false
    await loadProviders()
    ElMessage.success('已保存，热加载即时生效，无需重启')
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return
    ElMessage.error((e as Error).message)
  } finally {
    saving.value = false
  }
}

async function submitForm(): Promise<void> {
  await save({
    provider_id: providerId.value.trim(),
    api: api.value,
    base_url: baseUrl.value.trim(),
    api_key_env_id: apiKeyEnvId.value.trim(),
    auth_header: authHeader.value,
    models: models.value.map((m) => ({ ...m })),
  })
}

async function confirmRemove(pid: string): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确认删除 provider ${pid}？将级联清理默认模型引用并热加载生效。`,
      '删除 provider',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
  } catch {
    return // 用户取消
  }
  try {
    await removeProvider(current.value, pid)
    await loadProviders()
    ElMessage.success('已删除，热加载即时生效')
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return
    ElMessage.error((e as Error).message)
  }
}

onMounted(() => {
  void loadContainers()
})

// 暴露动作供测试（el-table row slot / el-form 在 stub 下不便点击，照 ContainersView 既定做法）
defineExpose({ selectContainer, openCreate, openEdit, save, confirmRemove })
</script>

<template>
  <div class="models">
    <div class="header">
      <h1>Model 配置</h1>
      <div class="actions">
        <select
          data-test="container-switch"
          :value="current"
          @change="selectContainer(($event.target as HTMLSelectElement).value)"
        >
          <option v-for="c in containers" :key="c.name" :value="c.name">{{ c.name }}</option>
        </select>
        <el-button type="primary" data-test="open-create" @click="openCreate">新增 provider</el-button>
      </div>
    </div>
    <p v-if="errorMsg" class="error">{{ errorMsg }}</p>
    <p class="hint">改后自动热加载，无需重启容器。</p>

    <el-table :data="providers" data-test="provider-table">
      <el-table-column prop="provider_id" label="Provider ID" />
      <el-table-column prop="api" label="接口类型" width="180" />
      <el-table-column prop="base_url" label="baseUrl" />
      <el-table-column prop="api_key_env_id" label="apiKey env id" width="160" />
      <el-table-column label="操作" width="180">
        <template #default="{ row }">
          <el-button size="small" :data-test="`edit-${row.provider_id}`" @click="openEdit(row)">编辑</el-button>
          <el-button
            type="danger"
            size="small"
            :data-test="`delete-${row.provider_id}`"
            @click="confirmRemove(row.provider_id)"
          >删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog
      v-model="dialogVisible"
      :title="editingPid ? '编辑 provider' : '新增 provider'"
      data-test="provider-dialog"
      width="560px"
    >
      <el-form>
        <el-form-item label="Provider ID">
          <el-input v-model="providerId" placeholder="小写字母开头，如 my-openai" data-test="field-provider-id" />
        </el-form-item>
        <el-form-item label="接口类型">
          <el-select v-model="api" data-test="field-api">
            <el-option label="OpenAI 兼容 (openai-completions)" value="openai-completions" />
            <el-option label="Anthropic 兼容 (anthropic-messages)" value="anthropic-messages" />
          </el-select>
        </el-form-item>
        <el-form-item label="baseUrl">
          <el-input v-model="baseUrl" placeholder="OpenAI 系需含 /v1" data-test="field-base-url" />
        </el-form-item>
        <el-form-item label="apiKey env id">
          <el-input v-model="apiKeyEnvId" placeholder="LLM_API_KEY（面板共享，容器仅注入它）" data-test="field-env-id" />
        </el-form-item>
        <el-form-item label="Authorization 头">
          <el-switch v-model="authHeader" data-test="field-auth-header" />
        </el-form-item>
        <el-form-item label="models">
          <div class="models-editor">
            <div v-for="(m, idx) in models" :key="idx" class="model-row">
              <el-input v-model="m.id" placeholder="model id（如 glm-4-plus）" />
              <el-input v-model="m.name" placeholder="展示名" />
              <el-button size="small" @click="removeModel(idx)">移除</el-button>
            </div>
            <el-button size="small" data-test="add-model" @click="addModel">添加 model</el-button>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button data-test="cancel-save" @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" data-test="submit-save" @click="submitForm">保存</el-button>
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
.actions {
  display: flex;
  gap: 12px;
  align-items: center;
}
.error {
  color: var(--el-color-danger);
}
.hint {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.models-editor {
  width: 100%;
}
.model-row {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}
</style>
