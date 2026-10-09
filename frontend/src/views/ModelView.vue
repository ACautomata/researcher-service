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
  getProviderImpact,
  listPresets,
  listProviders,
  removeProvider,
  testConnection,
  updateProvider,
  type EndpointPresetDTO,
  type ModelEntryDTO,
  type ModelProviderDTO,
  type ModelProviderWriteDTO,
  type PlatformEndpointDTO,
} from '@/api/models'
import {
  clearLlmAssignment,
  listLlmAssignments,
  setLlmAssignment,
  type PluginLlmAssignmentDTO,
  type PluginLlmTargetDTO,
} from '@/api/plugins'

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

// 端点试连（#882）：按当前表单态（预设 + key + 首条模型）发起；结果就地展示（成功=延迟，
// 失败=服务端净化后的错误文本）。key 留空 = 试平台共享 key（与保存语义一致的表单态）。
const testing = ref(false)
const probeSuccess = ref<string | null>(null) // '连接成功（1234 ms）'
const probeError = ref<string | null>(null)

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
    const [nextPlatform, nextPresets, nextProviders, nextAssignments] = await Promise.all([
      getPlatformEndpoint(),
      listPresets(),
      listProviders(),
      listLlmAssignments(),
    ])
    if (requestSeq === providerRequestSeq) {
      platform.value = nextPlatform
      presets.value = nextPresets
      providers.value = nextProviders
      llmTargets.value = [...nextAssignments.targets].sort((a, b) => Number(b.plugin_id === 'judge') - Number(a.plugin_id === 'judge'))
      llmAssignments.value = nextAssignments.assignments
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
  probeSuccess.value = null
  probeError.value = null
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
  probeSuccess.value = null
  probeError.value = null
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

async function save(payload: ModelProviderWriteDTO): Promise<void> {
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

async function runProbe(): Promise<void> {
  probeSuccess.value = null
  probeError.value = null
  const model = models.value[0]?.id.trim() ?? ''
  if (!model) {
    ElMessage.warning('请先填写 model id 再测试连接')
    return
  }
  testing.value = true
  try {
    const payload: { preset_id: string; api_key?: string; model: string } = {
      preset_id: presetId.value,
      model,
    }
    if (apiKey.value.trim() !== '') payload.api_key = apiKey.value
    const r = await testConnection(payload)
    probeSuccess.value = `连接成功（${r.latency_ms} ms）`
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return
    probeError.value = (e as Error).message
  } finally {
    testing.value = false
  }
}

async function confirmRemove(pid: string): Promise<void> {
  let impact
  try {
    impact = await getProviderImpact(pid)
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return
    ElMessage.error((e as Error).message)
    return
  }
  try {
    await ElMessageBox.confirm(
      `确认删除端点 ${pid}？${impact.total} 项将回落平台默认端点（会话偏好 ${impact.sessions}、插件指派 ${impact.plugins}、judge 指派 ${impact.judge}、teammate 模型钉 ${impact.teammates}）。在飞 run 将使用旧快照完成，下一 run 生效。`,
      '删除端点',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
  } catch {
    return // 用户取消
  }
  try {
    await removeProvider(pid)
    await loadAll()
    ElMessage.success('已删除，引用将在下一 run 回落平台默认端点')
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

// ---- 插件 LLM 指派区（#883 T3）：targets = 声明 llm 的插件 ∪ judge（后端目录派生）----
const llmTargets = ref<PluginLlmTargetDTO[]>([])
const llmAssignments = ref<PluginLlmAssignmentDTO[]>([])
const assignDialogVisible = ref(false)
const assigningTarget = ref<PluginLlmTargetDTO | null>(null)
const assignSaving = ref(false)
// '' = 跟随默认链（provider_id null）；platform 模型面 = 平台默认模型单条
const assignEndpoint = ref('')
const assignModel = ref('')

function assignmentDisplay(t: PluginLlmTargetDTO): string {
  const a = llmAssignments.value.find((row) => row.plugin_id === t.plugin_id)
  if (!a || a.provider_id === null) return '跟随默认链'
  if (a.provider_id === 'platform') {
    return `平台默认端点${a.model_id ? ` · ${a.model_id}` : ''}`
  }
  const provider = providers.value.find((p) => p.provider_id === a.provider_id)
  return `${provider?.provider_id ?? a.provider_id}${a.model_id ? ` · ${a.model_id}` : ' · 端点默认'}`
}

// 指派对话框的端点选项：平台默认端点 + 本人 BYOK 端点
const assignEndpointOptions = computed<Array<{ value: string; label: string }>>(() => [
  { value: 'platform', label: `平台默认端点（${platform.value?.default_model ?? '默认模型'}）` },
  ...providers.value.map((p) => ({ value: p.provider_id, label: `${p.provider_id}（${presetLabel(p.preset_id)}）` })),
])

// 所选端点的模型选项：platform = 平台预设 default_models 全集（与写侧校验域一致，#883
// review 收敛——只出 default_model 会窄于 API 接受面）；BYOK = 该端点 models 列表
const assignModelOptions = computed<ModelEntryDTO[]>(() => {
  if (assignEndpoint.value === 'platform') {
    const presetModels = presets.value.find((p) => p.id === platform.value?.preset_id)?.default_models ?? []
    if (presetModels.length > 0) return presetModels
    return platform.value?.default_model ? [{ id: platform.value.default_model, name: '平台默认模型' }] : []
  }
  return providers.value.find((p) => p.provider_id === assignEndpoint.value)?.models ?? []
})

function openAssign(t: PluginLlmTargetDTO): void {
  assigningTarget.value = t
  const current = llmAssignments.value.find((row) => row.plugin_id === t.plugin_id)
  assignEndpoint.value = current?.provider_id ?? ''
  assignModel.value = current?.model_id ?? ''
  assignDialogVisible.value = true
}

// 指派写动作统一包装：saving 态 + 401 静默（登出跳转面）+ 错误 toast + 成功刷新（与
// provider 保存面同纪律；三处写动作单一实现）。
async function runAssignmentAction(action: () => Promise<void>, successMessage: string): Promise<void> {
  assignSaving.value = true
  try {
    await action()
    assignDialogVisible.value = false
    await loadAll()
    ElMessage.success(successMessage)
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return
    ElMessage.error((e as Error).message)
  } finally {
    assignSaving.value = false
  }
}

async function submitAssign(): Promise<void> {
  const target = assigningTarget.value
  if (!target) return
  if (assignEndpoint.value === '') {
    // 跟随默认链 = 显式空指派行
    await runAssignmentAction(
      () => setLlmAssignment(target.plugin_id, { provider_id: null, model_id: null }).then(() => undefined),
      '已设为跟随默认链，下一 run 生效',
    )
    return
  }
  if (assignEndpoint.value !== 'platform' && !assignModelOptions.value.some((m) => m.id === assignModel.value)) {
    ElMessage.warning('请选择该端点下的模型')
    return
  }
  await runAssignmentAction(
    () => setLlmAssignment(target.plugin_id, {
      provider_id: assignEndpoint.value,
      model_id: assignEndpoint.value === 'platform' ? assignModel.value || null : assignModel.value,
    }).then(() => undefined),
    '已保存指派，下一 run 生效（在飞 run 不受影响）',
  )
}

async function confirmClearAssign(t: PluginLlmTargetDTO): Promise<void> {
  await runAssignmentAction(() => clearLlmAssignment(t.plugin_id), '已撤回指派（跟随默认链）')
}

onMounted(() => {
  void loadAll()
})

// 暴露动作供测试（el-table row slot / el-form 在 stub 下不便点击，expose 动作经 VM 驱动）
defineExpose({
  openCreate, openEdit, save, confirmRemove, loadAll, onPresetChange, runProbe, 
  openAssign, submitAssign, confirmClearAssign,
})
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

    <h2 class="section-title">插件 LLM 指派</h2>
    <p class="hint">为声明了 LLM 需求的插件单独指派端点与模型；缺省跟随默认链（你的端点序 + 平台垫底）。judge 审批判定器：显式指派 → 默认链 primary（首端点首模型）→ 平台默认；端点故障升级人工审批。指派后下一 run 生效，进行中 run 不受影响。</p>
    <el-table :data="llmTargets" data-test="assignment-table">
      <el-table-column prop="plugin_id" label="插件" width="160" />
      <el-table-column prop="description" label="用途" />
      <el-table-column label="当前指派" width="240">
        <template #default="{ row }">
          <span :data-test="`assignment-${row.plugin_id}`">{{ assignmentDisplay(row) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="200">
        <template #default="{ row }">
          <el-button size="small" :data-test="`assign-${row.plugin_id}`" @click="openAssign(row)">指派</el-button>
          <el-button
            v-if="llmAssignments.some((a) => a.plugin_id === row.plugin_id && a.provider_id !== null)"
            size="small"
            type="danger"
            :data-test="`clear-assign-${row.plugin_id}`"
            @click="confirmClearAssign(row)"
          >撤回</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog
      v-model="assignDialogVisible"
      :title="assigningTarget ? `指派 LLM：${assigningTarget.plugin_id}` : '指派 LLM'"
      data-test="assignment-dialog"
      width="480px"
    >
      <el-form>
        <el-form-item label="端点">
          <el-select v-model="assignEndpoint" data-test="assign-endpoint" placeholder="跟随默认链">
            <el-option
              v-for="opt in assignEndpointOptions"
              :key="opt.value"
              :label="opt.label"
              :value="opt.value"
            />
          </el-select>
        </el-form-item>
        <el-form-item v-if="assignEndpoint !== ''" label="模型">
          <el-select v-model="assignModel" data-test="assign-model" placeholder="端点默认（首条）模型">
            <el-option
              v-for="m in assignModelOptions"
              :key="m.id"
              :label="m.name ? `${m.name}（${m.id}）` : m.id"
              :value="m.id"
            />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button data-test="assign-cancel" @click="assignDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="assignSaving" data-test="assign-submit" @click="submitAssign">保存</el-button>
      </template>
    </el-dialog>

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
        <el-form-item label="测试连接">
          <div class="probe-row">
            <el-button :loading="testing" data-test="run-probe" @click="runProbe">测试连接</el-button>
            <span class="probe-hint">按当前表单态试连（key 留空 = 平台共享 key；取首条模型）</span>
          </div>
          <div v-if="probeSuccess" class="probe-result probe-success" data-test="probe-success">{{ probeSuccess }}</div>
          <div v-if="probeError" class="probe-result probe-error" data-test="probe-error">{{ probeError }}</div>
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
.section-title {
  margin: 24px 0 8px;
  font-size: 16px;
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
.probe-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.probe-hint {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.probe-result {
  width: 100%;
  font-size: 13px;
}
.probe-success {
  color: var(--el-color-success);
  font-size: 13px;
}
.probe-error {
  color: var(--el-color-danger);
  font-size: 13px;
}
.model-row {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}
</style>
