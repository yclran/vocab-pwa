<script setup>
/**
 * 拍照 OCR 面板
 *
 * 流程：选图/拍照 → （可选）框选区域 → 识别 → 逐条修正 → 交给上层导入
 *
 * 关于手写：Tesseract 的 eng 模型是印刷体训练的，手写识别率很低。
 * 所以手写模式下默认把所有结果都标成「待确认」，编辑框直接展开，
 * 并在界面上如实提示，不做过度承诺。
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import { loadImage, preprocess, recognize, toCandidates, terminateOCR } from '../services/ocr.js'
import { useUiStore } from '../stores/ui.js'

const emit = defineEmits(['confirm'])
const ui = useUiStore()

const fileInput = ref(null)
const cameraInput = ref(null)

const imgEl = ref(null) // HTMLImageElement
const imgUrl = ref('')
const mode = ref('print') // print | hand
const busy = ref(false)
const phase = ref('')
const progress = ref(0)

const candidates = ref([]) // { word, confidence, suspicious, checked }
const rawText = ref('')
const showRaw = ref(false)

/* ------------------------------ 框选 ------------------------------ */
const boxRef = ref(null)
const rect = ref(null) // 归一化 {x,y,w,h}
const dragging = ref(false)
let start = null

function onDown(e) {
  if (!imgUrl.value) return
  const r = boxRef.value.getBoundingClientRect()
  const p = e.touches?.[0] || e
  start = { x: (p.clientX - r.left) / r.width, y: (p.clientY - r.top) / r.height }
  dragging.value = true
  rect.value = { x: start.x, y: start.y, w: 0, h: 0 }
}

function onMove(e) {
  if (!dragging.value) return
  e.preventDefault()
  const r = boxRef.value.getBoundingClientRect()
  const p = e.touches?.[0] || e
  const cx = Math.min(Math.max((p.clientX - r.left) / r.width, 0), 1)
  const cy = Math.min(Math.max((p.clientY - r.top) / r.height, 0), 1)
  rect.value = {
    x: Math.min(start.x, cx),
    y: Math.min(start.y, cy),
    w: Math.abs(cx - start.x),
    h: Math.abs(cy - start.y),
  }
}

function onUp() {
  dragging.value = false
  // 太小的框当成误触
  if (rect.value && (rect.value.w < 0.04 || rect.value.h < 0.02)) rect.value = null
}

const rectStyle = computed(() =>
  rect.value
    ? {
        left: `${rect.value.x * 100}%`,
        top: `${rect.value.y * 100}%`,
        width: `${rect.value.w * 100}%`,
        height: `${rect.value.h * 100}%`,
      }
    : null
)

/* ------------------------------ 选图 ------------------------------ */

async function onPick(e) {
  const file = e.target.files?.[0]
  e.target.value = ''
  if (!file) return
  if (!file.type.startsWith('image/')) return ui.err('请选择图片文件')

  reset()
  imgUrl.value = URL.createObjectURL(file)
  try {
    imgEl.value = await loadImage(imgUrl.value)
  } catch {
    ui.err('图片加载失败')
  }
}

function reset() {
  if (imgUrl.value) URL.revokeObjectURL(imgUrl.value)
  imgUrl.value = ''
  imgEl.value = null
  rect.value = null
  candidates.value = []
  rawText.value = ''
  showRaw.value = false
}

/* ------------------------------ 识别 ------------------------------ */

async function run() {
  if (!imgEl.value) return
  busy.value = true
  phase.value = '准备识别引擎…'
  progress.value = 0
  try {
    const canvas = preprocess(imgEl.value, rect.value, {
      // 手写体二值化容易把笔画切断，保留灰度更稳
      binarize: mode.value === 'print',
      targetWidth: 1500,
    })

    const result = await recognize(canvas, {
      mode: mode.value,
      onProgress: (p) => {
        progress.value = Math.round((p.progress || 0) * 100)
        phase.value =
          p.phase === 'load' ? '首次使用需下载识别模型（约 15MB）…' : '正在识别文字…'
      },
    })

    rawText.value = result.text
    const list = toCandidates(result, { minLen: mode.value === 'hand' ? 2 : 3 })
    candidates.value = list.map((c) => ({
      ...c,
      // 手写结果一律默认不勾选，逼着人工过一遍
      checked: mode.value === 'print' ? !c.suspicious : false,
      suspicious: mode.value === 'hand' ? true : c.suspicious,
    }))

    if (!candidates.value.length) {
      ui.warn('没识别出英文单词，换个角度或放大再拍一次')
    } else {
      ui.ok(`识别到 ${candidates.value.length} 个候选词`)
    }
  } catch (e) {
    ui.err(`识别失败：${e.message}`)
  } finally {
    busy.value = false
    phase.value = ''
  }
}

/* ------------------------------ 修正 ------------------------------ */

function toggleAll() {
  const allOn = candidates.value.every((c) => c.checked)
  candidates.value.forEach((c) => (c.checked = !allOn))
}

function removeAt(i) {
  candidates.value.splice(i, 1)
}

function addBlank() {
  candidates.value.push({ word: '', confidence: 100, suspicious: false, checked: true })
}

const checkedWords = computed(() =>
  candidates.value
    .filter((c) => c.checked && /^[a-zA-Z][a-zA-Z'’\- ]*$/.test(c.word.trim()))
    .map((c) => ({ word: c.word.trim(), zh: null }))
)

function confirm() {
  if (!checkedWords.value.length) return ui.warn('没有勾选有效单词')
  emit('confirm', checkedWords.value)
}

onBeforeUnmount(() => {
  if (imgUrl.value) URL.revokeObjectURL(imgUrl.value)
  terminateOCR()
})
</script>

<template>
  <div class="space-y-3">
    <!-- 模式 -->
    <div class="flex gap-2">
      <button
        v-for="m in [
          { v: 'print', t: '印刷体', d: '课本 / 印刷讲义' },
          { v: 'hand', t: '手写体', d: '手写笔记本' },
        ]"
        :key="m.v"
        class="flex-1 rounded-xl px-3 py-2.5 text-left ring-1 transition"
        :class="mode === m.v ? 'bg-brand-50 ring-brand-400' : 'bg-white ring-slate-200'"
        @click="mode = m.v"
      >
        <p class="text-sm font-medium" :class="mode === m.v ? 'text-brand-700' : 'text-slate-700'">
          {{ m.t }}
        </p>
        <p class="text-[11px] text-slate-400">{{ m.d }}</p>
      </button>
    </div>

    <p v-if="mode === 'hand'" class="rounded-xl bg-amber-50 px-3 py-2.5 text-[12px] leading-relaxed text-amber-800">
      手写识别用的是印刷体训练的开源模型，<b>错误率很高</b>，只能当"帮你省点打字"用。
      识别结果全部默认不勾选，请逐条核对改正后再导入。
    </p>

    <!-- 选图 -->
    <div v-if="!imgUrl" class="grid grid-cols-2 gap-2">
      <button class="btn-primary py-3" @click="cameraInput.click()">
        <svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
          <path d="M4 8h3l2-2h6l2 2h3v11H4z" stroke-linejoin="round" />
          <circle cx="12" cy="13" r="3.2" />
        </svg>
        拍照
      </button>
      <button class="btn-ghost py-3" @click="fileInput.click()">从相册选择</button>
    </div>

    <input ref="cameraInput" type="file" accept="image/*" capture="environment" class="hidden" @change="onPick" />
    <input ref="fileInput" type="file" accept="image/*" class="hidden" @change="onPick" />

    <!-- 预览 + 框选 -->
    <div v-if="imgUrl" class="space-y-2">
      <div
        ref="boxRef"
        class="relative select-none overflow-hidden rounded-xl bg-slate-900"
        style="touch-action: none"
        @pointerdown="onDown"
        @pointermove="onMove"
        @pointerup="onUp"
        @pointerleave="onUp"
      >
        <img :src="imgUrl" class="block max-h-[46vh] w-full object-contain" draggable="false" />
        <div v-if="rectStyle" class="pointer-events-none absolute border-2 border-brand-400 bg-brand-400/20"
             :style="rectStyle" />
        <div v-if="!rect" class="pointer-events-none absolute inset-x-0 bottom-0 bg-slate-900/60 px-3 py-1.5 text-center text-[11px] text-white">
          在图上拖动可只识别划线区域（不框选则识别整张）
        </div>
      </div>

      <div class="flex gap-2">
        <button class="btn-ghost flex-1 text-xs" @click="reset">重选图片</button>
        <button v-if="rect" class="btn-ghost flex-1 text-xs" @click="rect = null">清除框选</button>
        <button class="btn-primary flex-[2]" :disabled="busy" @click="run">
          {{ busy ? '识别中…' : '开始识别' }}
        </button>
      </div>

      <div v-if="busy" class="rounded-xl bg-slate-100 p-3">
        <p class="text-xs text-slate-600">{{ phase }}</p>
        <div class="mt-1.5 h-1 overflow-hidden rounded-full bg-slate-300">
          <div class="h-full bg-brand-500 transition-all" :style="{ width: `${progress}%` }" />
        </div>
      </div>
    </div>

    <!-- 识别结果 -->
    <div v-if="candidates.length" class="space-y-2">
      <div class="flex items-center justify-between">
        <p class="text-xs font-medium text-slate-600">
          识别结果 {{ candidates.length }} 个 · 已选 {{ checkedWords.length }}
        </p>
        <div class="flex gap-3 text-xs">
          <button class="text-brand-600" @click="toggleAll">全选 / 全不选</button>
          <button class="text-slate-400" @click="showRaw = !showRaw">原始文本</button>
        </div>
      </div>

      <pre v-if="showRaw" class="max-h-32 overflow-auto rounded-xl bg-slate-900 p-3 text-[11px] leading-snug text-slate-200">{{ rawText || '（空）' }}</pre>

      <div class="max-h-[42vh] space-y-1.5 overflow-y-auto pr-0.5">
        <div
          v-for="(c, i) in candidates"
          :key="i"
          class="flex items-center gap-2 rounded-xl bg-white px-2.5 py-2 ring-1"
          :class="c.suspicious ? 'ring-amber-200' : 'ring-slate-200'"
        >
          <button
            class="flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 transition"
            :class="c.checked ? 'border-brand-600 bg-brand-600' : 'border-slate-300'"
            @click="c.checked = !c.checked"
          >
            <svg v-if="c.checked" class="h-3 w-3 text-white" fill="none" stroke="currentColor"
                 stroke-width="3.5" viewBox="0 0 24 24">
              <path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>

          <input
            v-model="c.word"
            class="min-w-0 flex-1 border-0 bg-transparent p-0 text-[15px] text-slate-800 outline-none"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            placeholder="修正或输入单词"
            @input="c.checked = true"
          />

          <span v-if="c.confidence" class="shrink-0 text-[10px]"
                :class="c.confidence >= 80 ? 'text-emerald-500' : c.confidence >= 60 ? 'text-amber-500' : 'text-rose-400'">
            {{ c.confidence }}%
          </span>
          <button class="shrink-0 rounded p-1 text-slate-300 active:text-rose-500" @click="removeAt(i)">
            ✕
          </button>
        </div>
      </div>

      <div class="flex gap-2">
        <button class="btn-ghost text-xs" @click="addBlank">＋ 手动补一个</button>
        <button class="btn-primary flex-1" :disabled="!checkedWords.length" @click="confirm">
          导入选中的 {{ checkedWords.length }} 个词
        </button>
      </div>
    </div>
  </div>
</template>
