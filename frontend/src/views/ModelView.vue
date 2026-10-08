<script setup lang="ts">
// Model 配置页（#881 预设制）：顶部平台默认端点只读卡 + 本人 BYOK 端点列表 + 新增/编辑表单。
// 端点 = 预设（六选一锁定协议与地址，无自由 baseURL 输入）+ 模型列表 + 可选自带 key（BYOK）。
// key 明文单向流：只在提交时发送；回显只有掩码（api_key_masked），编辑留空 = 保持不变。
// 写后经 config_meta version bump 热生效（无需重启，#775）。
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ApiError } from '@/api/client'
import {
  createProvider,
  getPlatformEndpoint,
  listPresets,
  listProviders,
  removeProvider,
  updateProvider,
  type EndpointPresetDTO,
  type ModelEntryDTO,
  type ModelProviderDTO,
  type PlatformEndpointDTO,
} from '@/api/models'

const platform = ref<PlatformEndpointDTO | null>(null)
const presets = ref<EndpointPresetDTO[]>([])
const providers = ref<ModelProviderDTO[]>([])
const providersLoading = ref(false)
const errorMsg = ref('')
let providerRequestSeq = 0

// 新增/编辑对话框（共用一表单）
const dialogVisible = ref(false)
const editingPid = ref<string | null>(null)   // null = 新建；非空 = 编辑该 pid
const saving = ref(false)
const providerId = ref('')
const presetId = ref('')
const apiKey = ref('') // 留空 = 新建用平台共享 key / 编辑保持不变（单向流：永回显明文）
const models = ref<ModelEntryDTO[]>([])

const selectedPreset = computed<EndpointPresetDTO | null>(
  () => presets.value.find((p) => p.id === presetId.value) ?? null,
)
const presetLabel = (pid: string): string =>
  presets.value.find((p) => p.id === pid)?.name ?? pid

async function loadAll(): Promise<void> {
  const requestSeq = ++providerRequestSeq
  providersLoading.value = true
  providers.value = []
  errorMsg.value = ''
  try {
    const [nextPlatform, nextPresets, nextProviders] = await Promise.all([
      getPlatformEndpoint(),
      listPresets(),
      listProviders(),
    ])
    if (requestSeq === providerRequestSeq) {
      platform.value = nextPlatform
      presets.value = nextPresets
      providers.value = nextProviders
    }
  } catch (e) {
    if (requestSeq === providerRequestSeq) {
      errorMsg.value = (e as Error).message
      providers.value = []
    }
  } finally {
    if (requestSeq === providerRequestSeq) {
      providersLoading.value = false
    }
  }
}

function resetForm(): void {
  providerId.value = ''
  presetId.value = presets.value[0]?.id ?? ''
  apiKey.value = ''
  models.value = []
  const def = selectedPreset.value?.default_models ?? []
  if (def.length) models.value = [{ ...def[0] }]
  else models.value = [{ id: '', name: '' }]
  editingPid.value = null
}

function openCreate(): void {
  resetForm()
  dialogVisible.value = true
}

function openEdit(p: ModelProviderDTO): void {
  editingPid.value = p.provider_id
  providerId.value = p.provider_id
  presetId.value = p.preset_id
  apiKey.value = '' // 单向流：不回显明文；留空提交 = 保持不变
  models.value = (p.models ?? []).map((m) => ({ ...m }))
  if (!models.value.length) models.value = [{ id: '', name: '' }]
  dialogVisible.value = true
}

function onPresetChange(): void {
  // 换预设 = 协议与地址锁定变更；模型列表预填该预设默认首条（可改）
  const def = selectedPreset.value?.default_models ?? []
  models.value = def.length ? [{ ...def[0] }] : [{ id: '', name: '' }]
}

function keyPlaceholder(): string {
  return editingPid.value ? '留空表示保持现有 key 不变' : '留空使用平台共享 key'
}

function addModel(): void {
  models.value.push({ id: '', name: '' })
}

function removeModel(idx: number): void {
  models.value.splice(idx, 1)
}

async function save(payload: {
  provider_id: string
  preset_id: string
  api_key?: string
  models: ModelEntryDTO[]
}): Promise<void> {
  // 零信任：前端也校验必填（key 可空——平台共享/保持不变语义）
  if (!payload.provider_id.trim()) {
    ElMessage.warning('provider_id 不能为空')
    return
  }
  if (!payload.preset_id) {
    ElMessage.warning('请选择端点预设')
    return
  }
  if (!payload.models.length || !payload.models[0].id.trim()) {
    ElMessage.warning('至少一条 model 且需含 id')
    return
  }
  saving.value = true
  try {
    if (editingPid.value) {
      await updateProvider(editingPid.value, payload)
    } else {
      await createProvider(payload)
    }
    dialogVisible.value = false
    await loadAll()
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
    preset_id: presetId.value,
    api_key: apiKey.value.trim() === '' ? undefined : apiKey.value,
    models: models.value.map((m) => ({ ...m })),
  })
}

async function confirmRemove(pid: string): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确认删除端点 ${pid}？引用它的会话偏好将失效——相关会话需重新选模后方可继续发消息。`,
      '删除端点',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
  } catch {
    return // 用户取消
  }
  try {
    await removeProvider(pid)
    await loadAll()
    ElMessage.success('已删除，热加载即时生效')
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return
    ElMessage.error((e as Error).message)
  }
}

function keyDisplay(p: ModelProviderDTO): string {
  if (p.key_error) return 'key 解密失败'
  if (p.api_key_masked) return p.api_key_masked
  return '平台共享 key'
}

onMounted(() => {
  void loadAll()
})

// 暴露动作供测试（el-table row slot / el-form 在 stub 下不便点击，expose 动作经 VM 驱动）
defineExpose({ openCreate, openEdit, save, confirmRemove, loadAll, onPresetChange })
</script>

<template>
  <div class="models">
    <div class="header">
      <h1>Model 配置</h1>
      <div class="actions">
        <el-button
          type="primary"
          data-test="open-create"
          :disabled="providersLoading"
          @click="openCreate"
        >新增端点</el-button>
      </div>
    </div>
    <p v-if="errorMsg" class="error">{{ errorMsg }}</p>
    <p class="hint">自带 API key（BYOK）从可信预设建端点；改后自动热加载，无需重启。</p>

    <el-card v-if="platform" class="platform-card" data-test="platform-card">
      <template #header>
        <div class="platform-header">
          <span>平台默认端点（开箱即用，只读）</span>
          <el-tag
            :type="platform.key_configured ? 'success' : 'danger'"
            data-test="platform-key-status"
          >{{ platform.key_configured ? '平台 key 已配置' : '平台 key 未配置' }}</el-tag>
        </div>
      </template>
      <div class="platform-body">
        <span>协议：{{ platform.protocol }}</span>
        <span>地址：{{ platform.base_url }}</span>
        <span>默认模型：{{ platform.default_model ?? '（未配置）' }}</span>
      </div>
    </el-card>

    <p v-if="providersLoading" class="hint" data-test="providers-loading">正在加载端点…</p>

    <el-table v-loading="providersLoading" :data="providers" data-test="provider-table">
      <el-table-column prop="provider_id" label="端点 ID" />
      <el-table-column label="预设" width="180">
        <template #default="{ row }">{{ presetLabel(row.preset_id) }}</template>
      </el-table-column>
      <el-table-column prop="base_url" label="地址（预设锁定）" />
      <el-table-column label="API key" width="200">
        <template #default="{ row }">
          <span :class="{ 'key-error': row.key_error }" :data-test="`key-${row.provider_id}`">{{ keyDisplay(row) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="180">
        <template #default="{ row }">
          <el-button
            size="small"
            :disabled="providersLoading"
            :data-test="`edit-${row.provider_id}`"
            @click="openEdit(row)"
          >编辑</el-button>
          <el-button
            type="danger"
            size="small"
            :disabled="providersLoading"
            :data-test="`delete-${row.provider_id}`"
            @click="confirmRemove(row.provider_id)"
          >删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog
      v-model="dialogVisible"
      :title="editingPid ? '编辑端点' : '新增端点'"
      data-test="provider-dialog"
      width="560px"
    >
      <el-form>
        <el-form-item label="端点 ID">
          <el-input v-model="providerId" placeholder="小写字母开头，如 my-openai" data-test="field-provider-id" />
        </el-form-item>
        <el-form-item label="端点预设">
          <el-select v-model="presetId" data-test="field-preset" @change="onPresetChange">
            <el-option
              v-for="p in presets"
              :key="p.id"
              :label="p.name"
              :value="p.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item v-if="selectedPreset" label="协议 / 地址（预设锁定）">
          <span class="locked" data-test="preset-locked">
            {{ selectedPreset.protocol }} · {{ selectedPreset.base_url }}
          </span>
        </el-form-item>
        <el-form-item label="API key">
          <el-input
            v-model="apiKey"
            type="password"
            show-password
            :placeholder="keyPlaceholder()"
            data-test="field-api-key"
          />
        </el-form-item>
        <el-form-item label="models">
          <div class="models-editor">
            <div v-for="(m, idx) in models" :key="idx" class="model-row">
              <el-input v-model="m.id" placeholder="model id（如 gpt-5.1）" />
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
.platform-card {
  margin-bottom: 16px;
}
.platform-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.platform-body {
  display: flex;
  gap: 24px;
  flex-wrap: wrap;
  font-size: 13px;
  color: var(--el-text-color-regular);
}
.key-error {
  color: var(--el-color-danger);
}
.locked {
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
