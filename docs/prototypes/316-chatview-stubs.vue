<!-- THROWAWAY PROTOTYPE for issue #316 —— 各组件 props/emits 桩（候选 B 落地）。
     只画边界与 slot 组合点，不实现逻辑；类型照抄现状 ChatView/ws.ts。 -->

<script setup lang="ts">
/* ============================== 类型（平移现状） ============================== */
interface Msg {
  role: 'user' | 'assistant'
  raw: string
  text: string
  thinking: string
  thinkingOpen: boolean
  streaming: boolean
  tools: ToolRow[]
}
interface ToolRow {
  id: string | null; name: string; state: 'running' | 'done' | 'error'
  title: string | null; input: unknown; result: unknown
}
interface ApprovalItem {
  id: string; kind: string; command: string; sessionKey: string | null
  status: 'pending' | 'resolving' | 'resolved'
  decision: '' | 'allow-once' | 'allow-always' | 'deny' | 'unknown'
  detailOpen: boolean
}
interface SlashOption { alias: string; description: string }
</script>

<!-- ═════════════════════════════ ChatView.vue（编排壳，唯一知道 store/conn/router） ═══ -->
<script setup lang="ts" name="ChatView">
// 候选 B：store = 响应式领域态；conn = 命令式连接生命周期 + runId 簇。
// const store = useChatStore()
// const conn  = useChatConnection(store)   // 注入 store，ws 帧 → store mutation
// onMounted(conn.loadInstances); onBeforeUnmount(conn.dispose)
</script>
<template>
  <div class="chat">
    <ChatSidebar
      :instances="store.instances" :sessions="store.sessions"
      :selected-container="store.selectedContainer" :selected-session="store.selectedSession"
      @select-container="conn.selectContainer" @select-session="conn.pickSession"
      @new-session="conn.newSession" @delete-session="conn.removeSession" />

    <main class="main">
      <ChatHeader :title="store.currentSessionTitle" :container="store.selectedContainer" :connecting="store.connecting">
        <template #banner>
          <!-- 父注入呈现：配对引导 / 错误条 / 断线重连条（逻辑在 conn/store，呈现在这） -->
          <div v-if="store.pairingNeeded" class="pair-guide">⚠️ 未完成设备配对…</div>
          <p v-if="store.errorMsg" class="error">{{ store.errorMsg }}</p>
          <p v-if="store.disconnected" class="error">
            连接已断开 <button @click="conn.connect()">重新连接</button>
          </p>
        </template>
      </ChatHeader>

      <ChatStream
        :messages="store.messages" :visible-approvals="store.visibleApprovals"
        :history-has-more="store.historyHasMore" :history-loading="store.historyLoading"
        :disconnected="store.disconnected"
        @load-more="conn.loadMoreHistory" @resolve-approval="conn.resolveApproval">
        <!-- slot 组合：父注入消息项/审批卡/空态的表现，不接管逻辑 -->
        <template #msg-item="{ m }"><ChatMessageItem :m="m" /></template>
        <template #approvals="{ list }">
          <ApprovalCard v-for="a in list" :key="a.id" :a="a" :disconnected="store.disconnected"
            @resolve="conn.resolveApproval" />
        </template>
        <template #empty><div class="empty">暂无消息，开始对话吧。</div></template>
      </ChatStream>

      <ChatComposer
        v-model="store.input" :send-disabled="store.sendDisabled"
        :slash-open="store.slashOpen" :slash-matches="store.slashMatches" :slash-index="store.slashIndex"
        @input="conn.onComposerInput" @keydown="conn.onComposerKeydown"
        @send="conn.send" @pick-slash="conn.pickSlash" />
    </main>
  </div>
</template>

<!-- ═════════════════════════════ ChatSidebar.vue（哑） ═════════════════════════════ -->
<script setup lang="ts" name="ChatSidebar">
interface InstanceDTO { name: string; status: string }
interface SessionDTO { session_key: string; title: string; updated_at: string }
defineProps<{ instances: InstanceDTO[]; sessions: SessionDTO[]
  selectedContainer: string; selectedSession: string }>()
defineEmits<{ (e:'select-container', name:string):void; (e:'select-session', key:string):void
  (e:'new-session'):void; (e:'delete-session', key:string):void }>()
</script>

<!-- ═════════════════════════════ ChatHeader.vue（哑 + banner slot） ══════════════ -->
<script setup lang="ts" name="ChatHeader">
defineProps<{ title: string; container: string; connecting: boolean }>()
</script>
<template>
  <div class="topbar">
    <span class="title">{{ title || '对话' }}</span>
    <span v-if="container" class="tag">{{ container }}</span>
    <span v-if="connecting" class="tag warn">连接中…</span>
  </div>
  <slot name="banner" />  <!-- 错误/断线/配对引导，父注入 -->
</template>

<!-- ════════════════════ ChatStream.vue（哑壳，3 个 slot 组合点） ══════════════════ -->
<script setup lang="ts" name="ChatStream">
defineProps<{ messages: Msg[]; visibleApprovals: ApprovalItem[]
  historyHasMore: boolean; historyLoading: boolean; disconnected: boolean }>()
defineEmits<{ (e:'load-more'):void; (e:'resolve-approval', a:ApprovalItem, d:'allow-once'|'deny'):void }>()
</script>
<template>
  <div class="stream">
    <button v-if="historyHasMore" :disabled="historyLoading" @click="$emit('load-more')">
      {{ historyLoading ? '加载中…' : '加载更多' }}</button>

    <div v-for="(m, i) in messages" :key="`m-${i}`" class="msg" :class="m.role">
      <slot name="msg-item" :m="m">
        <ChatMessageItem :m="m" />   <!-- 默认实现，可被父覆盖 -->
      </slot>
    </div>

    <slot name="approvals" :list="visibleApprovals">
      <ApprovalCard v-for="a in visibleApprovals" :key="a.id" :a="a" :disconnected="disconnected"
        @resolve="(ap,d)=>$emit('resolve-approval', ap, d)" />
    </slot>

    <slot v-if="!messages.length && !visibleApprovals.length" name="empty" />
  </div>
</template>

<!-- ═══════════════ ChatMessageItem.vue（哑，自身 3 个 slot 供再定制） ══════════════ -->
<script setup lang="ts" name="ChatMessageItem">
defineProps<{ m: Msg }>()
</script>
<template>
  <div class="bubble">
    <slot name="thinking" :m="m">
      <ThinkingCard v-if="m.role==='assistant' && m.thinking" :thinking="m.thinking" :open="m.thinkingOpen" />
    </slot>
    <slot name="tool-line" :tools="m.tools">
      <ToolLine v-for="(t,ti) in m.tools" :key="ti" :tool="t" />
    </slot>
    <slot name="text" :m="m">{{ m.text }}<span v-if="m.streaming" class="cursor"></span></slot>
  </div>
</template>

<!-- ═══════════════════ 叶子哑组件 ═══════════════════ -->
<script setup lang="ts" name="ThinkingCard">
defineProps<{ thinking: string; open: boolean }>()   // <details> 折叠卡
</script>

<script setup lang="ts" name="ToolLine">
defineProps<{ tool: ToolRow }>()
// slot:args（默认 formatToolInput(tool.input)）；状态着色 css 类 .running/.error/.done
</script>

<script setup lang="ts" name="ApprovalCard">
defineProps<{ a: ApprovalItem; disconnected: boolean }>()
defineEmits<{ (e:'resolve', a:ApprovalItem, d:'allow-once'|'deny'):void; (e:'toggle-detail', a:ApprovalItem):void }>()
// slot:detail（默认 a-detail 展开命令全文/id/kind）
</script>

<!-- ═══════════════════ ChatComposer.vue（哑，v-model + slash-menu slot） ══════════════ -->
<script setup lang="ts" name="ChatComposer">
defineProps<{ modelValue: string; sendDisabled: boolean
  slashOpen: boolean; slashMatches: SlashOption[]; slashIndex: number }>()
defineEmits<{ (e:'update:modelValue', v:string):void; (e:'input'):void
  (e:'keydown', ev:KeyboardEvent):void; (e:'send'):void; (e:'pick-slash', o:SlashOption):void }>()
</script>
<template>
  <div class="composer">
    <slot name="slash-menu" :matches="slashMatches" :index="slashIndex" :pick="(o)=>$emit('pick-slash',o)">
      <div v-if="slashOpen" class="slash-menu">
        <div v-for="(o,i) in slashMatches" :key="o.alias" class="slash-item" :class="{sel:i===slashIndex}"
          @mousedown.prevent="$emit('pick-slash', o)">
          <span class="cmd">{{ o.alias }}</span><span class="desc">{{ o.description }}</span>
        </div>
      </div>
    </slot>
    <textarea :value="modelValue" rows="2"
      @input="$emit('update:modelValue', ($event.target as HTMLTextAreaElement).value); $emit('input')"
      @keydown="$emit('keydown', $event)" />
    <button :disabled="sendDisabled" @click="$emit('send')">发送</button>
  </div>
</template>

<!-- ═══════════════════ 状态宿主（候选 B 两件的接口草） ═══════════════════ -->
<script lang="ts">
// stores/chat.ts —— 响应式领域态 + 纯 mutation（无 WS 句柄、无定时器、无 runId 簇）
//   state: instances/sessions/selected*/messages/approvals/input/commands/分页态/flags
//   getters: currentSessionTitle/streaming/visibleApprovals/slashMatches/sendDisabled
//   mutations(纯): applyText/applyTool/finalizeLast/upsertApproval/setSessions/…
//
// useChatConnection(store) —— 命令式生命周期 + runId 簇（闭包持有 ws/定时器/runId 集）
//   返回: { loadInstances, selectContainer, pickSession, newSession, removeSession,
//           connect, dispose, send, resolveApproval, loadHistory, loadMoreHistory,
//           onComposerInput, onComposerKeydown, pickSlash }
//   内部: openSocket/scheduleReconnect/recoverUnauthorized/claimResumedRun/abandonActiveRun
//         + activeRunId/abandonedRunIds/pendingSend/resumePending/resumeClaimed
//         + containerGen/historyGen/reconnectTimer  —— ws 帧回调只调 store mutation
</script>
