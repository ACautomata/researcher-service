<script setup lang="ts">
// 插件中心页（#799 目录页 + #1058 D 票 Skill 市场分区）：双 tab。
//   「插件」= 编译期目录（能力可见性唯一入口 + per-user 启用位，开关态不预改——失败自然回落）；
//   「Skill 市场」= 市场数据面（B 票 REST）：**发布 ≠ 启用** 两概念显式区分（intro 文案 +
//   开关文案），启用开关乐观更新 + 失败回滚（初始态 = 列表 enabled 字段，D 票 server 请求者
//   维度扩展）；删除入口作者本人/admin 可见（uploaderName === auth.username / role==='admin'）
//   + 确认弹层；上传走 multipart（FormData field 'file'——client.ts 对 FormData 不设
//   Content-Type，浏览器自带 boundary），拒收原因（A 票结构化 reasons[]）逐条展示，成功即时
//   刷新列表。类别单选/筛选 = D5 枚举（api/skills.ts 前端单源）；server 以 SKILL.md
//   frontmatter 为类别权威（B 票决策）——上传表单选择仅 UX 预填，成功 toast 展示落库类别。
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useAuthStore } from '@/stores/auth'
import { listPlugins, setPluginEnablement, type PluginSummary } from '@/api/plugins'
import {
  deleteSkill,
  listSkills,
  readSkillBlob,
  setSkillEnablement,
  uploadSkill,
  SKILL_CATEGORIES,
  SKILL_CATEGORY_LABELS,
  type SkillCategory,
  type SkillMarketItem,
} from '@/api/skills'

// ---- 插件目录（#799，原语义保留）----
const plugins = ref<PluginSummary[]>([])
const loading = ref(true)
const pendingId = ref('')

// ---- Skill 市场（#1058）----
const auth = useAuthStore()
const activeTab = ref('plugins')
const skills = ref<SkillMarketItem[]>([])
const skillsLoading = ref(true)
const skillPendingId = ref('')
const skillCategory = ref('')
const skillQuery = ref('')
const uploading = ref(false)
const uploadFile = ref<File | null>(null)
const uploadCategory = ref<SkillCategory>('other')
const uploadErrors = ref<string[]>([])
const uploadMessage = ref('')

const categoryOptions: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '全部' },
  ...SKILL_CATEGORIES.map((value) => ({ value, label: SKILL_CATEGORY_LABELS[value] })),
]

onMounted(() => {
  load()
  loadSkills()
})

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

async function loadSkills(): Promise<void> {
  skillsLoading.value = true
  try {
    skills.value = await listSkills({
      ...(skillCategory.value ? { category: skillCategory.value } : {}),
      ...(skillQuery.value.trim() ? { q: skillQuery.value.trim() } : {}),
    })
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : 'Skill 市场加载失败')
  } finally {
    skillsLoading.value = false
  }
}

function setCategory(value: string): void {
  if (skillCategory.value === value) return
  skillCategory.value = value
  void loadSkills()
}

function searchSkills(): void {
  void loadSkills()
}

function onUploadFile(e: Event): void {
  const input = e.target as HTMLInputElement
  uploadFile.value = input.files?.[0] ?? null
  uploadErrors.value = []
  uploadMessage.value = ''
}

function categoryLabel(category: string): string {
  return (SKILL_CATEGORY_LABELS as Readonly<Record<string, string>>)[category] ?? category
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('zh-CN', { hour12: false })
}

function canDelete(s: SkillMarketItem): boolean {
  return auth.role === 'admin' || s.uploaderName === auth.username
}

// 启用开关乐观更新（#1058 验收面）：先改本地态即时反馈，失败回滚 + 错误 toast。
// 启用语义 = 下一 run 注入（C 票 per-run 快照——进行中 run 不中断，同插件 Q12）。
async function toggleSkill(s: SkillMarketItem, enabled: boolean): Promise<void> {
  if (skillPendingId.value !== '') return
  skillPendingId.value = s.id
  const previous = s.enabled
  s.enabled = enabled
  try {
    await setSkillEnablement(s.id, enabled)
    ElMessage.success(enabled ? `已启用 ${s.name}（新会话生效）` : `已停用 ${s.name}`)
  } catch (e) {
    s.enabled = previous
    ElMessage.error(e instanceof Error ? e.message : '操作失败')
  } finally {
    skillPendingId.value = ''
  }
}

async function submitUpload(): Promise<void> {
  if (uploading.value || !uploadFile.value) return
  uploading.value = true
  uploadErrors.value = []
  uploadMessage.value = ''
  try {
    const result = await uploadSkill(uploadFile.value)
    if (result.ok) {
      ElMessage.success(`已发布 ${result.name}（类别：${categoryLabel(result.category)}，市场全员可见）`)
      uploadFile.value = null
      uploadCategory.value = 'other'
      await loadSkills()
    } else {
      uploadMessage.value = result.message
      uploadErrors.value = result.reasons
    }
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '上传失败')
  } finally {
    uploading.value = false
  }
}

async function confirmDelete(s: SkillMarketItem): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除后市场即刻下架且启用位随之清空，不可恢复。确认删除「${s.name}」？`,
      '删除 Skill',
      { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' },
    )
  } catch {
    return // 用户取消
  }
  try {
    await deleteSkill(s.id)
    skills.value = skills.value.filter((x) => x.id !== s.id)
    ElMessage.success(`已删除 ${s.name}`)
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '删除失败')
  }
}

async function downloadSkill(s: SkillMarketItem): Promise<void> {
  try {
    const blob = await readSkillBlob(s.id)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${s.name}.zip`
    a.click()
    URL.revokeObjectURL(url)
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '下载失败')
  }
}
</script>

<template>
  <div class="plugins-view">
    <ElTabs v-model="activeTab" data-test="plugins-tabs">
      <ElTabPane label="插件" name="plugins">
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
      </ElTabPane>
      <ElTabPane label="Skill 市场" name="skills">
        <h2>Skill 市场</h2>
        <p class="intro">
          社区上传的技能数据包，<strong>发布</strong>即全员可见，但只有你<strong>启用</strong>的 skill 才会注入本账号会话（目录行 + read_skill；新会话生效）。删除仅作者本人与管理员可操作。
        </p>
        <div class="upload-box" data-test="skill-upload-form">
          <div class="upload-row">
            <input type="file" accept=".zip" data-test="skill-upload-file" @change="onUploadFile" />
            <select v-model="uploadCategory" data-test="skill-upload-category" class="category-select">
              <option v-for="c in SKILL_CATEGORIES" :key="c" :value="c">{{ SKILL_CATEGORY_LABELS[c] }}</option>
            </select>
            <button class="btn primary" data-test="skill-upload-submit" :disabled="uploading || !uploadFile" @click="submitUpload">
              {{ uploading ? '上传中…' : '上传发布' }}
            </button>
          </div>
          <p class="upload-hint">zip 内需含 SKILL.md（frontmatter name/description/category 为准）；整包 ≤1MB，仅 md/txt/图片白名单。</p>
          <p v-if="uploadMessage" class="upload-msg" data-test="skill-upload-message">{{ uploadMessage }}</p>
          <ul v-if="uploadErrors.length" class="upload-errors" data-test="skill-upload-errors">
            <li v-for="r in uploadErrors" :key="r" data-test="skill-upload-error-item">{{ r }}</li>
          </ul>
        </div>
        <div class="filters">
          <button
            v-for="c in categoryOptions"
            :key="c.value"
            class="chip"
            :class="{ active: skillCategory === c.value }"
            data-test="skill-category-option"
            :data-value="c.value"
            @click="setCategory(c.value)"
          >{{ c.label }}</button>
          <input
            v-model="skillQuery"
            class="search"
            data-test="skill-search"
            placeholder="搜索名称/描述"
            @keyup.enter="searchSkills"
          />
          <button class="btn" data-test="skill-search-btn" @click="searchSkills">搜索</button>
        </div>
        <p v-if="skillsLoading" class="state">加载中…</p>
        <p v-else-if="skills.length === 0" class="state" data-test="skill-empty">暂无 Skill</p>
        <div
          v-for="s in skills"
          v-else
          :key="s.id"
          class="plugin-card"
          data-test="skill-card"
        >
          <div class="head">
            <div class="title">
              <strong>{{ s.name }}</strong>
              <span class="category">{{ categoryLabel(s.category) }}</span>
            </div>
            <ElSwitch
              :model-value="s.enabled"
              :loading="skillPendingId === s.id"
              :disabled="skillPendingId !== ''"
              @change="(v: unknown) => toggleSkill(s, v === true)"
            />
          </div>
          <p class="desc">{{ s.description }}</p>
          <div class="meta">上传者 {{ s.uploaderName || '未知' }} · {{ formatTime(s.publishedAt) }} · {{ s.fileCount }} 个文件</div>
          <div class="actions">
            <button class="btn" data-test="skill-download" @click="downloadSkill(s)">下载 zip</button>
            <button v-if="canDelete(s)" class="btn danger" data-test="skill-delete" @click="confirmDelete(s)">删除</button>
          </div>
        </div>
      </ElTabPane>
    </ElTabs>
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
.category { color: var(--el-color-primary); font-size: 12px; background: var(--el-color-primary-light-9); border: 1px solid var(--el-color-primary-light-7); border-radius: 6px; padding: 1px 8px; }
.desc { margin: 6px 0 0; color: var(--el-text-color-regular); font-size: 13px; }
.commands { margin-top: 8px; display: flex; gap: 8px; flex-wrap: wrap; }
.cmd { font-family: ui-monospace, monospace; font-size: 12px; background: var(--el-fill-color); border: 1px solid var(--el-border-color); border-radius: 6px; padding: 1px 8px; }
.upload-box { border: 1px dashed var(--el-border-color); border-radius: 10px; padding: 12px 14px; margin: 10px 0 14px; }
.upload-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.category-select { border: 1px solid var(--el-border-color); border-radius: 6px; padding: 4px 8px; font-size: 13px; background: var(--el-fill-color-blank); color: var(--el-text-color-regular); }
.btn { border: 1px solid var(--el-border-color); border-radius: 6px; padding: 4px 12px; font-size: 13px; background: var(--el-fill-color-blank); color: var(--el-text-color-regular); cursor: pointer; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn.primary { background: var(--el-color-primary); border-color: var(--el-color-primary); color: #fff; }
.btn.danger { color: var(--el-color-danger); border-color: var(--el-color-danger-light-5); }
.upload-hint { margin: 8px 0 0; color: var(--el-text-color-placeholder); font-size: 12px; }
.upload-msg { margin: 8px 0 0; color: var(--el-color-danger); font-size: 13px; }
.upload-errors { margin: 6px 0 0; padding-left: 20px; color: var(--el-color-danger); font-size: 13px; }
.filters { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
.chip { border: 1px solid var(--el-border-color); border-radius: 14px; padding: 3px 12px; font-size: 13px; background: var(--el-fill-color-blank); color: var(--el-text-color-regular); cursor: pointer; }
.chip.active { background: var(--el-color-primary); border-color: var(--el-color-primary); color: #fff; }
.search { flex: 1; min-width: 140px; border: 1px solid var(--el-border-color); border-radius: 6px; padding: 4px 10px; font-size: 13px; background: var(--el-fill-color-blank); color: var(--el-text-color-regular); }
.meta { margin-top: 6px; color: var(--el-text-color-placeholder); font-size: 12px; }
.actions { margin-top: 8px; display: flex; gap: 8px; }
</style>
