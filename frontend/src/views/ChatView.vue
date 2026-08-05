<script setup lang="ts">
// 对话页编排壳（#316 候选 B / #340：#316 拆分定案——8 组件边界，本文件只做编排）。
// 连接生命周期 × runId 路由 × 消息投影的非响应式簇全在 useChatConnection（composable 闭包）；
// 响应式投影（messages/approvals/sessions/commands/输入）在 chatStore（纯 mutation）；
// 8 个展示组件全 props-in/emits-out 哑组件（ChatSidebar/ChatHeader/ChatStream/ChatComposer +
// ChatMessageItem/ThinkingCard/ToolLine/ApprovalCard），6 slot 全开（msg-item/thinking/tool-line/
// empty/slash-menu/banner——#399 起审批卡并入 ChatStream 合并时间线渲染，approvals slot 删除），
// 表现父注入、逻辑留宿主。
// 行为与拆分前一致：同 wire（隧道 + 官方协议机）、同 reconnect（4401 刷新重建/退避重连）、同 ping/pong。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { listInstances } from '@/api/containers'
import { ApiError } from '@/api/client'
import { useChatStore } from '@/stores/chat'
import { useChatConnection } from '@/chat/useChatConnection'
import ChatSidebar from '@/components/chat/ChatSidebar.vue'
import ChatHeader from '@/components/chat/ChatHeader.vue'
import ChatStream from '@/components/chat/ChatStream.vue'
import ChatComposer from '@/components/chat/ChatComposer.vue'

const chat = useChatStore()
// 视图专属态（connecting/errorMsg 上抛至此，disconnected 在 composable 内）
const connecting = ref(false)
const errorMsg = ref('')

const conn = useChatConnection({
  onConnecting(v: boolean) {
    connecting.value = v
  },
  onError(message: string) {
    errorMsg.value = message
  },
  onClearError() {
    errorMsg.value = ''
  },
})

// 嵌套 ref 在模板中不解包（conn 是普通对象）——顶层解构后模板自动解包（slash 匹配单一来源在
// useChatConnection，此处只消费）
const slashOpen = conn.slashOpen
const slashMatches = conn.slashMatches

const currentSessionTitle = computed(() => {
  const s = chat.sessions.find((x) => x.session_key === chat.selectedSession)
  return s?.title || (s ? s.session_key.slice(0, 8) : '') || ''
})

// 是否有助手消息正在流式；并发 send 会让旧 streaming 消息永久卡住光标，故流式中禁发
const streaming = computed(() => chat.messages.some((m) => m.role === 'assistant' && m.streaming))

// codex R2 P1：审批卡按 sessionKey **留存全部**（不丢弃非当前会话的），仅渲染时按当前会话过滤——
// 切到该会话即可看到/回覆，agent 不再因切会话而永久丢失待审批卡。无 sessionKey（连接级）任何会话可见。
const visibleApprovals = computed(() =>
  chat.approvals.filter((a) => !a.sessionKey || a.sessionKey === chat.selectedSession),
)

// 删除会话：确认（ElMessageBox）由本壳注入（composable 内不持有 UI）
async function confirmRemoveSession(): Promise<boolean> {
  try {
    await ElMessageBox.confirm(
      '确认删除该会话？网关会先归档（可恢复）再删除。',
      '删除会话',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
    return true
  } catch {
    return false // 用户取消
  }
}

async function removeSession(key: string): Promise<void> {
  const ok = await conn.removeSession(key, confirmRemoveSession)
  if (ok) ElMessage.success('会话已删除')
}

function toggleApprovalDetail(a: { id: string }): void {
  chat.toggleApprovalDetail(a.id)
}

async function loadInstances() {
  try {
    chat.setInstances(await listInstances())
    // B0: 总是走 selectContainer——同名且连接活着（gateway 非空）时其内部 early-return 跳过；
    // 切页（unmount dispose 断网关）后 remount 时 store 残留 selectedContainer，gateway 已死，
    // 必须重建连接，否则连接死而 UI 看似活着（send/resolveApproval 静默 no-op）。
    if (chat.instances.length) {
      await conn.selectContainer(chat.selectedContainer || chat.instances[0].name)
    }
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return
    errorMsg.value = (e as Error).message
  }
}

onMounted(loadInstances)
onBeforeUnmount(() => {
  conn.dispose()
})

defineExpose({
  selectContainer: conn.selectContainer,
  send: () => conn.send(streaming.value),
  newSession: conn.newSession,
})
</script>

<template>
  <div class="chat">
    <ChatSidebar
      :instances="chat.instances"
      :sessions="chat.sessions"
      :selected-container="chat.selectedContainer"
      :selected-session="chat.selectedSession"
      @select-container="conn.selectContainer"
      @select-session="conn.pickSession"
      @remove-session="removeSession"
      @new-session="conn.newSession"
    />
    <main class="main">
      <ChatHeader
        :title="currentSessionTitle"
        :container="chat.selectedContainer"
        :connecting="connecting"
      />
      <p v-if="errorMsg" class="error" data-test="error-bar">{{ errorMsg }}</p>
      <!-- issue #239：断线手动重连入口——直接调 connect()（绕开 selectContainer 同名 early-return）。
           codex #249 R3 P2：由 disconnected 独立渲染，不套在 errorMsg 的 <p v-if> 里——断线后切会话
           loadHistory 会清 errorMsg，若入口随错误条消失则 disconnected 仍 true、发送仍禁用，单容器用户
           只能刷新页面。断开期间始终提供重连路径。 -->
      <p v-if="conn.disconnected.value" class="error" data-test="reconnect-bar">
        连接已断开
        <button class="reconnect" data-test="reconnect" @click="conn.connect()">重新连接</button>
      </p>
      <ChatStream
        :messages="chat.messages"
        :approvals="visibleApprovals"
        :disconnected="conn.disconnected.value"
        :history-has-more="chat.historyHasMore"
        :history-loading="chat.historyLoading"
        @load-more="conn.loadMoreHistory"
        @resolve-approval="conn.resolveApproval"
        @toggle-approval-detail="toggleApprovalDetail"
      />
      <ChatComposer
        v-model="chat.input"
        :matches="slashMatches"
        :slash-open="slashOpen"
        :slash-index="chat.slashIndex"
        :connecting="connecting"
        :streaming="streaming"
        :disconnected="conn.disconnected.value"
        @input="conn.onComposerInput"
        @keydown="conn.onComposerKeydown"
        @send="conn.send(streaming)"
        @pick-slash="conn.pickSlash"
      >
        <!-- T07 斜杠补全菜单表现（父注入，逻辑留宿主 useChatConnection） -->
        <template #slash-menu="{ matches, slashIndex }">
          <div v-if="matches.length" class="slash-menu" data-test="slash-menu">
            <div
              v-for="(o, i) in matches"
              :key="o.alias"
              class="slash-item"
              :class="{ sel: i === slashIndex }"
              data-test="slash-item"
              @mousedown.prevent="conn.pickSlash(o.alias)"
            >
              <span class="cmd">{{ o.alias }}</span><span class="desc">{{ o.description }}</span>
            </div>
          </div>
        </template>
      </ChatComposer>
    </main>
  </div>
</template>

<style scoped>
.chat { display: flex; height: calc(100vh - 40px); }
.main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.error { margin: 0; padding: 8px 18px; color: var(--el-color-danger); background: var(--el-color-danger-light-9); }
.error .reconnect { margin-left: 10px; background: transparent; border: 1px solid currentColor; border-radius: 6px; padding: 1px 10px; cursor: pointer; color: inherit; font-size: 12.5px; }

/* T07 斜杠补全菜单（spec §9.4 / 原型 oc-chat-page.html）：弹在输入框上方，cmd mono + 描述 */
.slash-menu { position: absolute; bottom: calc(100% + 6px); left: 18px; right: 18px; max-height: 280px; overflow-y: auto; background: var(--el-bg-color-overlay); border: 1px solid var(--el-border-color); border-radius: 11px; box-shadow: 0 -8px 30px rgba(0, 0, 0, .18); z-index: 10; }
.slash-item { display: flex; align-items: center; gap: 10px; padding: 9px 14px; cursor: pointer; }
.slash-item.sel, .slash-item:hover { background: var(--el-fill-color); }
.slash-item .cmd { font-family: ui-monospace, monospace; color: var(--el-color-primary); font-size: 13px; }
.slash-item .desc { margin-left: auto; color: var(--el-text-color-secondary); font-size: 12px; }
</style>
