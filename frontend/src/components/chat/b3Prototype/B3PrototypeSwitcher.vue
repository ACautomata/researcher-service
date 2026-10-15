<!-- B3 原型（#933）变体切换条——一次性原型代码，勿引为生产实现。
     底部居中浮动药丸：← / → 循环三变体（URL ?variant= 同步，可分享、刷新稳定），
     另附「退出原型」清参回原版。样式高对比深色药丸，与被评审页面明显区隔。
     通用原型纪律（prototype skill）：输入焦点在 textarea/input/contenteditable 或
     原型自绘控件（data-b3 子树，如滑块拖拽中）时不劫持方向键。 -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import { B3_VARIANTS, b3OverrideText, b3Variant, type B3VariantKey } from './b3State'

defineOptions({ name: 'B3PrototypeSwitcher' })

const LABELS: Record<B3VariantKey, string> = {
  A: '内嵌底栏',
  B: '语境头栏',
  C: '全内嵌舱',
}

// 变体写 URL（replaceState 不触发路由导航）：?variant=A 可直接分享，删参 = 退出原型。
function apply(v: B3VariantKey | ''): void {
  b3Variant.value = v
  const url = new URL(window.location.href)
  if (v) url.searchParams.set('variant', v)
  else url.searchParams.delete('variant')
  window.history.replaceState(null, '', url)
}

function cycle(dir: 1 | -1): void {
  const current = b3Variant.value || 'A'
  const index = B3_VARIANTS.indexOf(current)
  apply(B3_VARIANTS[(index + dir + B3_VARIANTS.length) % B3_VARIANTS.length])
}

function onKey(e: KeyboardEvent): void {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
  const target = e.target as HTMLElement | null
  if (
    target &&
    (target.isContentEditable ||
      /^(input|textarea|select)$/i.test(target.tagName) ||
      target.closest('[data-b3]'))
  ) {
    return
  }
  e.preventDefault()
  cycle(e.key === 'ArrowRight' ? 1 : -1)
}

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="b3-bar" data-b3 data-test="b3-switcher">
    <span class="b3-tag">B3 原型 #933</span>
    <button type="button" class="b3-arrow" aria-label="上一个变体" @click="cycle(-1)">←</button>
    <strong class="b3-label">{{ b3Variant ? `${b3Variant} · ${LABELS[b3Variant]}` : '原版' }}</strong>
    <button type="button" class="b3-arrow" aria-label="下一个变体" @click="cycle(1)">→</button>
    <button type="button" class="b3-exit" @click="apply('')">退出</button>
    <span class="b3-readout" :title="b3OverrideText">mock preferredModelJson = {{ b3OverrideText }}（只读不落库）</span>
  </div>
</template>

<style scoped>
.b3-bar {
  position: fixed;
  left: 50%;
  bottom: 12px;
  transform: translateX(-50%);
  z-index: 2000;
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: min(92vw, 860px);
  padding: 8px 14px;
  background: rgba(24, 27, 36, 0.94);
  color: #fff;
  border-radius: 999px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
  font-size: 12px;
}
.b3-tag { font-weight: 700; letter-spacing: 0.5px; color: #ffd666; white-space: nowrap; }
.b3-label { white-space: nowrap; }
.b3-arrow {
  width: 26px; height: 26px;
  border: none; border-radius: 50%;
  background: rgba(255, 255, 255, 0.14);
  color: #fff; font-size: 13px; line-height: 1;
  cursor: pointer;
}
.b3-arrow:hover { background: rgba(255, 255, 255, 0.28); }
.b3-exit { border: 1px solid rgba(255, 255, 255, 0.35); background: transparent; color: rgba(255, 255, 255, 0.85); border-radius: 999px; padding: 3px 10px; font-size: 11px; cursor: pointer; white-space: nowrap; }
.b3-exit:hover { border-color: #fff; color: #fff; }
.b3-readout { font-family: ui-monospace, monospace; font-size: 11px; opacity: 0.78; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
