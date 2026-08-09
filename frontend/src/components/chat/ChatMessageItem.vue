<script setup lang="ts">
// 单条聊天消息（#316：#340 拆分边界，props-in/emits-out 哑组件）。
// thinking/tool-line slot 注入点：默认渲染 ThinkingCard/ToolLine；父可经 slot 覆盖表现。
// #401 / ticket #402：assistant 正文走 MarkdownRenderer（v-html + DOMPurify 消毒），
// user 保持纯文本（用户输入的 * # _ 不当语法）；流式光标由 MarkdownRenderer streaming 控制。
// #459-T3 #464：附件媒体块（msg.media）渲染——image→img / audio→audio controls / video→video
// controls；src 为纯 base64，此处重建完整 dataURL（data:<mime>;base64,<src>）。user 与 assistant
// 均渲染（user 发送的附件 echo / AI 工具产出的多媒体如 browser 截图）。
import type { Msg } from '@/stores/chat'
import type { MediaBlock } from '@/chat/eventTranslate'
import ThinkingCard from '@/components/chat/ThinkingCard.vue'
import ToolLine from '@/components/chat/ToolLine.vue'
import MarkdownRenderer from '@/components/chat/MarkdownRenderer.vue'

defineProps<{
  msg: Msg
}>()

defineSlots<{
  thinking?: (props: { thinking: string; thinkingOpen: boolean }) => unknown
  'tool-line'?: (props: { tool: Msg['tools'][number] }) => unknown
}>()

// 媒体块 src（纯 base64）→ 完整 dataURL。<img>/<audio>/<video> 的 src 须带 data:<mime>;base64, 前缀。
// 0 信任：src 已是完整 dataURL（带 data: 前缀）时原样返回，否则补前缀（采集/网关两源 content 形态兼容）。
function mediaSrc(m: MediaBlock): string {
  return m.src.startsWith('data:') ? m.src : `data:${m.mimeType};base64,${m.src}`
}
</script>

<template>
  <div class="msg" :class="msg.role">
    <div class="bubble">
      <!-- T08 思考链折叠卡（spec §8.3 (a) / r26 §4） -->
      <slot name="thinking" :thinking="msg.thinking" :thinking-open="msg.thinkingOpen">
        <ThinkingCard v-if="msg.role === 'assistant' && msg.thinking" :thinking="msg.thinking" :thinking-open="msg.thinkingOpen" />
      </slot>
      <!-- T08 工具执行（spec §9.4 / 原型 oc-chat-page） -->
      <template v-for="(t, ti) in msg.tools" :key="`tool-${ti}`">
        <slot name="tool-line" :tool="t">
          <ToolLine :tool="t" />
        </slot>
      </template>
      <!-- #401：assistant 渲染 markdown（含流式光标），user 保持纯文本 + 光标 -->
      <MarkdownRenderer v-if="msg.role === 'assistant'" :text="msg.text" :streaming="msg.streaming" />
      <template v-else>{{ msg.text }}<span v-if="msg.streaming" class="cursor"></span></template>
      <!-- #459-T3 #464：附件媒体块（image/audio/video）——历史/流式/发送 echo 三源统一渲染。
           纯图片消息（text 空）也经此渲染出图片，不影响对话展示。 -->
      <div v-if="msg.media.length" class="media-list" data-test="media-list">
        <template v-for="(m, mi) in msg.media" :key="`media-${mi}`">
          <img
            v-if="m.type === 'image'"
            class="media-image"
            data-test="media-image"
            :src="mediaSrc(m)"
            :alt="m.fileName || '图片附件'"
            loading="lazy"
          />
          <audio
            v-else-if="m.type === 'audio'"
            class="media-audio"
            data-test="media-audio"
            :src="mediaSrc(m)"
            controls
            preload="metadata"
          ></audio>
          <video
            v-else-if="m.type === 'video'"
            class="media-video"
            data-test="media-video"
            :src="mediaSrc(m)"
            controls
            preload="metadata"
          ></video>
        </template>
      </div>
      <div v-if="msg.role === 'assistant' && !msg.streaming" class="ai-notice" data-test="ai-notice">
        内容由 AI 生成，仅供参考
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 自适应宽度：fit-content 但钳在 [min,max] 区间——短回复不塌成细条（min-width 下限），
   长回复仍满 840px（max-width 上限），AI/user 左右对齐形成清晰视觉分区。 */
.msg { display: flex; min-width: 280px; max-width: 840px; }
.msg.user { align-self: flex-end; }
/* #498：.bubble 是 .msg 的 flex item，须 min-width:0 才能收缩到内容 min-content 以下——
   否则 ToolLine 内连续无空格超长命令（min-content 可达上千 px）会把 .bubble 顶出 .msg 的
   840px 上限（item 默认 min-width:auto 溢出父界），且 .t-args 的 ellipsis 截断无从生效。 */
.bubble { padding: 10px 14px; border-radius: 12px; word-break: break-word; min-width: 0; }
.msg.assistant .bubble { background: var(--el-fill-color-light); white-space: normal; }
.msg.user .bubble { background: var(--el-color-primary-light-8); white-space: pre-wrap; }
.ai-notice {
  margin-top: 8px;
  padding-top: 7px;
  border-top: 1px solid var(--el-border-color-lighter);
  color: var(--el-text-color-placeholder);
  font-size: 12px;
  line-height: 1.4;
}
.cursor { display: inline-block; width: 7px; height: 14px; background: var(--el-color-primary); vertical-align: -2px; animation: blink 1s steps(1) infinite; }
@keyframes blink { 50% { opacity: 0; } }

/* #459-T3 #464：附件媒体块——约束在气泡宽度内，多附件纵向堆叠留白 */
.media-list { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
.media-list:first-child { margin-top: 0; }
.media-image { max-width: 100%; max-height: 320px; border-radius: 8px; object-fit: contain; display: block; }
.media-audio { max-width: 100%; width: 320px; display: block; }
.media-video { max-width: 100%; max-height: 320px; border-radius: 8px; display: block; }

</style>
