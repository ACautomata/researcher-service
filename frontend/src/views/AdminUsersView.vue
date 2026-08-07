<script setup lang="ts">
// admin 账号管理页（#328 / #340-D）：users 表 + 行内动作（禁用/启用二次确认、重置密码
// 一次性明文 modal、配额 inline 数字输入）+ 新建用户。state 用局部 ref 不开 store。
// 自禁（禁用自己）后端拒 10044 → toast 提示；重置密码回显明文仅此一次，关闭后不可再取。
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ApiError } from '@/api/errors'
import {
  createUser,
  listUsers,
  patchUser,
  resetUserPassword,
  type UserRowDTO,
} from '@/api/users'

const users = ref<UserRowDTO[]>([])
const loading = ref(false)
const errorMsg = ref('')

// 新建用户对话框
const createVisible = ref(false)
const newUsername = ref('')
const newPassword = ref('')
const newMaxContainers = ref<number | undefined>(undefined)
const creating = ref(false)

// 重置密码一次性明文 modal
const resetVisible = ref(false)
const resetTarget = ref<UserRowDTO | null>(null)
const resetPassword = ref('')
const resettingUserId = ref('')
// 配额 inline 编辑：key=userId，value=输入中的数字（undefined=未在编辑）
const quotaEditing = ref<Record<string, string>>({})

async function refresh(): Promise<void> {
  loading.value = true
  errorMsg.value = ''
  try {
    const data = await listUsers()
    users.value = data.users
  } catch (e) {
    errorMsg.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

async function openCreate(): Promise<void> {
  newUsername.value = ''
  newPassword.value = ''
  newMaxContainers.value = undefined
  createVisible.value = true
}

async function submitCreate(): Promise<void> {
  if (!newUsername.value.trim()) {
    ElMessage.warning('请填写用户名')
    return
  }
  if (!newPassword.value) {
    ElMessage.warning('请填写临时密码')
    return
  }
  creating.value = true
  try {
    await createUser({
      username: newUsername.value.trim(),
      password: newPassword.value,
      ...(newMaxContainers.value !== undefined ? { maxContainers: newMaxContainers.value } : {}),
    })
    createVisible.value = false
    await refresh()
    ElMessage.success('用户已创建，首次登录需修改密码')
  } catch (e) {
    ElMessage.error((e as Error).message)
  } finally {
    creating.value = false
  }
}

async function toggleActive(u: UserRowDTO): Promise<void> {
  if (u.isActive) {
    // 禁用：二次确认
    try {
      await ElMessageBox.confirm(
        `确认禁用用户 ${u.username}？禁用后其立即失去访问（REST + WS 均在下一次校验时拒绝）。`,
        '禁用用户',
        { type: 'warning', confirmButtonText: '禁用', cancelButtonText: '取消' },
      )
    } catch {
      return // 用户取消
    }
  }
  try {
    await patchUser(u.id, { isActive: !u.isActive })
    await refresh()
    ElMessage.success(u.isActive ? `用户 ${u.username} 已禁用` : `用户 ${u.username} 已启用`)
  } catch (e) {
    if (e instanceof ApiError && (e as unknown as { code?: number }).code === 10044) {
      ElMessage.error('不能禁用自己')
    } else {
      ElMessage.error((e as Error).message)
    }
  }
}

async function openReset(u: UserRowDTO): Promise<void> {
  // 重置会立即作废上一次临时密码；一次只允许一个请求，确保展示的就是有效结果。
  if (resettingUserId.value) return
  resettingUserId.value = u.id
  try {
    const { password } = await resetUserPassword(u.id)
    resetTarget.value = u
    resetPassword.value = password
    resetVisible.value = true
  } catch (e) {
    ElMessage.error((e as Error).message)
  } finally {
    resettingUserId.value = ''
  }
}

function closeReset(): void {
  resetVisible.value = false
  resetTarget.value = null
  resetPassword.value = ''
}

// 配额 inline：开始编辑 → 保存（数字校验本地兜底；后端非法返 10043）
function beginQuotaEdit(u: UserRowDTO): void {
  quotaEditing.value = { ...quotaEditing.value, [u.id]: String(u.quota.limit) }
}

function isQuotaEditing(userId: string): boolean {
  return quotaEditing.value[userId] !== undefined
}

async function saveQuota(u: UserRowDTO): Promise<void> {
  const raw = quotaEditing.value[u.id] ?? ''
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) {
    ElMessage.warning('配额须为非负整数')
    return
  }
  try {
    await patchUser(u.id, { maxContainers: n })
    const next = { ...quotaEditing.value }
    delete next[u.id]
    quotaEditing.value = next
    await refresh()
    ElMessage.success('配额已更新')
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

onMounted(refresh)

// 暴露行内动作 + 配额编辑态供测试/父组件触发（el-table row scoped slot 在 stub 下渲染脆弱，
// 贴 ContainersView 模式；quotaEditing 暴露使配额编辑可在 stub 下经 VM 驱动）
defineExpose({
  refresh,
  toggleActive,
  openReset,
  resettingUserId,
  beginQuotaEdit,
  isQuotaEditing,
  saveQuota,
  quotaEditing,
})
</script>

<template>
  <div class="admin-users">
    <div class="header">
      <h1>账号管理</h1>
      <el-button type="primary" data-test="open-create-user" @click="openCreate">新建用户</el-button>
    </div>
    <p v-if="errorMsg" class="error">{{ errorMsg }}</p>

    <el-table :data="users" v-loading="loading" data-test="users-table">
      <el-table-column prop="username" label="用户名" width="160" />
      <el-table-column prop="role" label="角色" width="80" />
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag :type="row.isActive ? 'success' : 'info'" size="small">
            {{ row.isActive ? '启用' : '禁用' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="配额" width="170">
        <template #default="{ row }">
          <span v-if="!isQuotaEditing(row.id)" data-test="quota-view">
            {{ row.quota.used }}/{{ row.quota.limit }}
          </span>
          <span v-else class="quota-edit">
            <el-input
              v-model="quotaEditing[row.id]"
              size="small"
              :data-test="`quota-input-${row.username}`"
              style="width: 80px"
              @keyup.enter="saveQuota(row)"
            />
            <el-button size="small" :data-test="`quota-save-${row.username}`" @click="saveQuota(row)">
              保存
            </el-button>
          </span>
        </template>
      </el-table-column>
      <el-table-column label="改密" width="70">
        <template #default="{ row }">
          <el-tag
            v-if="row.mustChangePassword"
            type="warning"
            size="small"
            :data-test="`must-change-${row.username}`"
          >待改密</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="createdAt" label="创建时间" width="180" />
      <el-table-column label="操作" width="240">
        <template #default="{ row }">
          <el-button
            v-if="!isQuotaEditing(row.id)"
            size="small"
            :data-test="`edit-quota-${row.username}`"
            @click="beginQuotaEdit(row)"
          >
            改配额
          </el-button>
          <el-button
            size="small"
            :type="row.isActive ? 'danger' : 'success'"
            :data-test="`toggle-active-${row.username}`"
            @click="toggleActive(row)"
          >
            {{ row.isActive ? '禁用' : '启用' }}
          </el-button>
          <el-button
            size="small"
            :loading="resettingUserId === row.id"
            :disabled="resettingUserId !== ''"
            :data-test="`reset-password-${row.username}`"
            @click="openReset(row)"
          >
            重置密码
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="createVisible" title="新建用户" data-test="create-user-dialog" width="420px">
      <el-form label-width="80px">
        <el-form-item label="用户名">
          <el-input v-model="newUsername" placeholder="3–30 位字母/数字/下划线/连字符" data-test="new-username" />
        </el-form-item>
        <el-form-item label="临时密码">
          <el-input v-model="newPassword" type="password" placeholder="至少 8 个字符" data-test="new-password" />
        </el-form-item>
        <el-form-item label="配额">
          <el-input-number v-model="newMaxContainers" :min="0" :controls="false" placeholder="默认" data-test="new-quota" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button data-test="cancel-create-user" @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="creating" data-test="submit-create-user" @click="submitCreate">
          创建
        </el-button>
      </template>
    </el-dialog>

    <!-- 重置密码：一次性明文回显（关闭后不可再取），且已撤销该用户全部 refresh token -->
    <el-dialog
      v-model="resetVisible"
      title="重置密码"
      data-test="reset-password-dialog"
      width="440px"
      :close-on-click-modal="false"
      @closed="closeReset"
    >
      <p class="reset-hint">
        用户 <strong>{{ resetTarget?.username }}</strong> 的新临时密码（仅显示这一次，关闭后不可再取；该用户全部会话已失效，下次登录须修改密码）：
      </p>
      <p class="reset-pw" data-test="reset-password-plaintext">{{ resetPassword }}</p>
      <template #footer>
        <el-button type="primary" data-test="close-reset-password" @click="resetVisible = false">
          我已抄下，关闭
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
.quota-edit {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.reset-hint {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.reset-pw {
  font-family: ui-monospace, monospace;
  font-size: 16px;
  background: var(--el-fill-color);
  border: 1px dashed var(--el-color-warning);
  border-radius: 8px;
  padding: 10px 14px;
  word-break: break-all;
}
</style>
