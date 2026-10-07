<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import type { WikiPageContentDTO, WikiClaimsDTO, WikiGraphDTO } from '@/api/wiki'
import MarkdownRenderer from '@/components/chat/MarkdownRenderer.vue'
import { parseWikiDocument, resolveWikiLink } from '@/wiki/reader'
const props = defineProps<{ page: WikiPageContentDTO; claims: WikiClaimsDTO | null; claimsError: boolean; graph: WikiGraphDTO }>()
const emit = defineEmits<{ open: [path: string, anchor?: string] }>()
const root = ref<HTMLElement>()
const doc = computed(() => parseWikiDocument(props.page.content, props.page.title))
const backlinks = computed(() => props.graph.nodes.filter(node =>
  !node.ghost && props.graph.edges.some(edge => edge.to === props.page.path && edge.from === node.id),
))
function navigate(event: MouseEvent) {
  const link = (event.target as HTMLElement).closest('a')
  if (!link || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
  const href = link.getAttribute('href') ?? ''
  if (href.startsWith('#')) {
    event.preventDefault()
    void scrollToAnchor(href.slice(1))
    return
  }
  const target = resolveWikiLink(props.page.path, href)
  if (target) { event.preventDefault(); emit('open', target.path, target.anchor) }
}
async function scrollToAnchor(anchor: string) {
  await nextTick()
  // markdown-it does not create heading ids; GitHub-style slugs support OKF anchors.
  for (const heading of root.value?.querySelectorAll('h1,h2,h3,h4,h5,h6') ?? []) {
    const slug = (heading.textContent ?? '').toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-')
    if (heading.id === anchor || slug === anchor) { heading.scrollIntoView?.({ block: 'start' }); break }
  }
}
defineExpose({ scrollToAnchor })
</script>

<template>
  <div ref="root" class="wiki-preview" data-test="wiki-preview">
    <article>
      <header class="document-header">
        <div v-if="doc.type" class="eyebrow">{{ doc.type }}</div>
        <h1>{{ doc.title }}</h1>
        <p v-if="doc.description" class="description">{{ doc.description }}</p>
        <div class="tags"><span v-for="tag in doc.tags" :key="tag" class="chip">{{ tag }}</span></div>
        <div v-if="page.okf" class="badges" data-test="okf-badges">
          <span v-if="page.okf.status" class="chip">状态：{{ page.okf.status }}</span>
          <span v-if="page.okf.staleAfter" class="chip">保鲜期限：{{ page.okf.staleAfter }}</span>
          <span v-if="page.okf.generatedAt" class="chip">生成：{{ page.okf.generatedAt }}</span>
        </div>
      </header>
      <div @click="navigate"><MarkdownRenderer :text="doc.body" :streaming="false" /></div>
      <footer v-if="backlinks.length" class="backlinks" data-test="backlinks">
        <h2>引用</h2>
        <button v-for="node in backlinks" :key="node.id" class="chip" @click="emit('open', node.id)">{{ node.title }}</button>
      </footer>
    </article>
    <aside class="claims" aria-label="论断证据" data-test="claims">
      <h2>论断证据</h2>
      <p v-if="claimsError" role="alert">证据加载失败，请重新打开页面重试</p>
      <template v-else-if="claims">
        <p>页版本：{{ claims.drift === 'fresh' ? '一致' : claims.drift === 'drifted' ? '已漂移' : '未知' }}</p>
        <p v-if="!claims.claims.length">暂无论断证据</p>
        <section v-for="(claim, index) in claims.claims" :key="claim.id || index" class="claim">
          <p>{{ claim.statement }}</p>
          <!-- repo:// points into the generation source repository, which has no browser read API.
               Preserve the exact file/line locator instead of inventing a broken HTTP link. -->
          <ul><li v-for="evidence in claim.evidence" :key="evidence.resource"><code>{{ evidence.resource }}</code></li></ul>
        </section>
      </template>
      <p v-else>正在加载证据…</p>
    </aside>
  </div>
</template>

<style scoped>
.wiki-preview { display: flex; gap: 24px; line-height: 1.65; overflow-wrap: anywhere; }
article { flex: 1; min-width: 0; }
.document-header { border-bottom: 1px solid var(--el-border-color); padding-bottom: 20px; margin-bottom: 24px; }
h1 { margin: 6px 0; font-size: 28px; }
h2 { font-size: 15px; }
.eyebrow { color: var(--el-color-primary); text-transform: uppercase; font-size: 12px; letter-spacing: .12em; }
.description { color: var(--el-text-color-secondary); }
.tags, .badges { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
.chip { background: var(--el-fill-color-light); color: var(--el-text-color-regular); padding: 2px 9px; border-radius: 12px; border: 1px solid var(--el-border-color-lighter); font-size: 12px; }
button.chip { cursor: pointer; margin-right: 6px; }
.backlinks { margin-top: 32px; border-top: 1px solid var(--el-border-color); }
.claims { flex: 0 0 240px; border-left: 1px solid var(--el-border-color); padding-left: 16px; font-size: 13px; }
.claim { border-top: 1px solid var(--el-border-color-lighter); }
.claim ul { padding-left: 18px; }
@media (max-width: 1100px) { .wiki-preview { flex-direction: column; } .claims { flex-basis: auto; border-left: 0; border-top: 1px solid var(--el-border-color); padding-left: 0; } }
</style>
