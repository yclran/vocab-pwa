<script setup>
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { parseText, readFile } from '../services/importParser.js'
import { useVocabStore } from '../stores/vocab.js'
import { useUiStore } from '../stores/ui.js'
import { useSettingsStore } from '../stores/settings.js'
import OcrPanel from '../components/OcrPanel.vue'

const router = useRouter()
const vocab = useVocabStore()
const ui = useUiStore()
const settings = useSettingsStore()

const TABS = [
  { v: 'paste', t: '粘贴文本' },
  { v: 'file', t: '文件' },
  { v: 'photo', t: '拍照' },
]
const tab = ref('paste')

const targetGroups = ref(['g_mine'])
const raw = ref('')
const parseMode = ref('auto') // auto | lines | prose
const fileName = ref('')
const importing = ref(false)

/** 预览条目：可逐条编辑、删除 */
const preview = ref(null) // { mode, entries:[{word,zh,checked}], stats, skipped }

const SAMPLE = `ability 能力
absent 缺席的
abandon
achieve 实现；达到`

const checkedEntries = computed(
  () => preview.value?.entries.filter((e) => e.checked && e.word.trim()) || []
)

function toggleGroup(id) {
  const s = new Set(targetGroups.value)
  s.has(id) ? s.delete(id) : s.add(id)
  targetGroups.value = s.size ? [...s] : ['g_mine']
}

/* ------------------------------ 解析 ------------------------------ */

function doParse(text, { silent = false } = {}) {
  const t = String(text || '').trim()
  if (!t) {
    preview.value = null
    return
  }
  const r = parseText(t, {
    mode: parseMode.value,
    filterStopwords: settings.s.filterStopwords,
    minLen: 3,
  })
  preview.value = {
    mode: r.mode,
    stats: r.stats,
    skipped: r.skipped,
    dropped: r.dropped || { short: [], stopword: [] },
    entries: r.entries.map((e) => ({ ...e, checked: true })),
  }
  if (!silent) {
    if (!r.entries.length) ui.warn('没解析出单词，检查一下文本内容')
    else ui.ok(`解析出 ${r.entries.length} 个词`)
  }
}

/** 文章提词模式下被规则丢掉的词总数 */
const droppedCount = computed(
  () => (preview.value?.stats.droppedShort || 0) + (preview.value?.stats.droppedStopword || 0)
)

const droppedSample = computed(() => {
  const d = preview.value?.dropped
  if (!d) return ''
  return [...d.stopword, ...d.short].slice(0, 12).join('、')
})

/** 一键改用词表模式：把被过滤的词全部找回来 */
function useLinesMode() {
  parseMode.value = 'lines'
  doParse(raw.value)
}

/** 一键关掉高频词过滤后重解析 */
function keepStopwords() {
  settings.s.filterStopwords = false
  doParse(raw.value)
}

function reparse() {
  if (raw.value.trim()) doParse(raw.value, { silent: true })
}

async function onFile(e) {
  const file = e.target.files?.[0]
  e.target.value = ''
  if (!file) return
  ui.setBusy('正在读取文件…')
  try {
    const text = await readFile(file)
    ui.setBusy(null)
    if (!text.trim()) return ui.warn('文件里没有读到文字内容')
    fileName.value = file.name
    raw.value = text
    doParse(text)
  } catch (err) {
    ui.setBusy(null)
    ui.err(err.message)
  }
}

async function onPaste() {
  try {
    const text = await navigator.clipboard.readText()
    if (!text.trim()) return ui.warn('剪贴板是空的')
    raw.value = text
    doParse(text)
  } catch {
    ui.warn('浏览器不允许读剪贴板，请长按输入框手动粘贴')
  }
}

function onOcrConfirm(words) {
  preview.value = {
    mode: 'lines',
    stats: { total: words.length, withZh: 0, withoutZh: words.length, skipped: 0 },
    skipped: [],
    entries: words.map((w) => ({ ...w, checked: true })),
  }
  // 拍照来的词默认进「手写收集词」，除非用户已经改过
  if (targetGroups.value.length === 1 && targetGroups.value[0] === 'g_mine') {
    targetGroups.value = ['g_hand']
  }
  tab.value = 'paste'
  ui.ok('已放入下方待导入列表，确认后入库')
}

/* ------------------------------ 入库 ------------------------------ */

async function commit() {
  const entries = checkedEntries.value.map((e) => ({
    word: e.word.trim(),
    zh: e.zh?.trim() || null,
  }))
  if (!entries.length) return ui.warn('没有勾选任何单词')

  importing.value = true
  try {
    await vocab.importEntries(entries, targetGroups.value)
    preview.value = null
    raw.value = ''
    fileName.value = ''
    router.push({ name: 'library', params: { groupId: targetGroups.value[0] } })
  } catch (e) {
    ui.err(e.message)
  } finally {
    importing.value = false
  }
}

function clearAll() {
  raw.value = ''
  fileName.value = ''
  preview.value = null
}
</script>

<template>
  <div class="mx-auto max-w-lg space-y-4 p-4">
    <!-- 目标词本 -->
    <section class="card p-4">
      <h2 class="text-sm font-semibold text-slate-900">导入到哪个词本</h2>
      <p class="mt-0.5 text-[11px] text-slate-400">可多选，重复的单词会自动去重并合并归属</p>
      <div class="mt-2.5 flex flex-wrap gap-1.5">
        <button
          v-for="g in vocab.groups"
          :key="g.id"
          class="chip ring-1 transition"
          :class="targetGroups.includes(g.id)
            ? 'bg-brand-600 text-white ring-brand-600'
            : 'bg-white text-slate-500 ring-slate-200'"
          @click="toggleGroup(g.id)"
        >
          {{ g.name }}
        </button>
      </div>
    </section>

    <!-- 入口切换 -->
    <div class="flex gap-1 rounded-xl bg-slate-200/60 p-1">
      <button
        v-for="t in TABS"
        :key="t.v"
        class="flex-1 rounded-lg py-2 text-sm font-medium transition"
        :class="tab === t.v ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'"
        @click="tab = t.v"
      >
        {{ t.t }}
      </button>
    </div>

    <!-- 粘贴 -->
    <section v-show="tab === 'paste'" class="card space-y-2.5 p-4">
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-semibold text-slate-900">粘贴单词表或整段英文</h3>
        <button class="text-xs text-brand-600" @click="onPaste">读取剪贴板</button>
      </div>
      <textarea
        v-model="raw"
        rows="7"
        class="input font-mono text-[13px] leading-relaxed"
        :placeholder="SAMPLE"
        autocapitalize="off"
        autocorrect="off"
        spellcheck="false"
      />
      <div class="flex items-center gap-2">
        <select v-model="parseMode" class="input w-auto py-2 text-[13px]" @change="reparse">
          <option value="auto">自动识别格式</option>
          <option value="lines">按行（词表）</option>
          <option value="prose">整段文章提词</option>
        </select>
        <button class="btn-primary flex-1" :disabled="!raw.trim()" @click="doParse(raw)">解析</button>
      </div>
      <p class="text-[11px] leading-relaxed text-slate-400">
        支持「一行一个单词」和「单词 中文」两种格式混排，也能直接丢一整段英文文章自动提词。
      </p>
    </section>

    <!-- 文件 -->
    <section v-show="tab === 'file'" class="card space-y-3 p-4">
      <h3 class="text-sm font-semibold text-slate-900">上传 TXT / Word 文档</h3>
      <label class="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-slate-300 py-8 active:bg-slate-50">
        <svg class="h-7 w-7 text-slate-400" fill="none" stroke="currentColor" stroke-width="1.6" viewBox="0 0 24 24">
          <path d="M12 16V4m0 0L8 8m4-4l4 4M4 20h16" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span class="mt-2 text-sm text-slate-600">点击选择文件</span>
        <span class="mt-0.5 text-[11px] text-slate-400">.txt / .docx / .md / .csv</span>
        <input type="file" accept=".txt,.docx,.md,.csv,text/plain" class="hidden" @change="onFile" />
      </label>
      <p v-if="fileName" class="rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
        已读取：{{ fileName }}
      </p>
      <p class="text-[11px] leading-relaxed text-slate-400">
        旧版 .doc 不支持，请在 Word 里另存为 .docx。<br />
        TXT 请用 UTF-8 编码保存，否则中文会乱码。
      </p>
    </section>

    <!-- 拍照 -->
    <section v-show="tab === 'photo'" class="card p-4">
      <h3 class="mb-3 text-sm font-semibold text-slate-900">拍照识别单词</h3>
      <OcrPanel @confirm="onOcrConfirm" />
    </section>

    <!-- 解析预览 -->
    <section v-if="preview" class="card space-y-3 p-4">
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-semibold text-slate-900">待导入 {{ checkedEntries.length }} 个词</h3>
        <button class="text-xs text-slate-400" @click="clearAll">清空</button>
      </div>

      <div class="flex flex-wrap gap-1.5 text-[11px]">
        <span class="chip bg-slate-100 text-slate-600">
          {{ preview.mode === 'lines' ? '词表模式' : '文章提词模式' }}
        </span>
        <span class="chip bg-emerald-50 text-emerald-600">自带中文 {{ preview.stats.withZh }}</span>
        <span class="chip bg-amber-50 text-amber-600">需联网补全 {{ preview.stats.withoutZh }}</span>
        <span v-if="preview.stats.skipped" class="chip bg-rose-50 text-rose-600">
          跳过 {{ preview.stats.skipped }} 行
        </span>
      </div>

      <!--
        文章提词模式会按规则丢词（高频虚词 + 少于3个字母）。
        不显式说出来，用户只会看到「粘了26个只出来10个」而无从判断原因。
      -->
      <div v-if="preview.mode === 'prose' && droppedCount"
           class="rounded-xl bg-amber-50 px-3 py-2.5 text-[11px] leading-relaxed text-amber-800">
        <p class="font-medium">
          按「整段文章」处理，已自动丢掉 {{ droppedCount }} 个词
          <span class="font-normal text-amber-600">
            （{{ preview.stats.droppedStopword }} 个高频虚词、{{ preview.stats.droppedShort }} 个不足 3 字母）
          </span>
        </p>
        <p v-if="droppedSample" class="mt-1 text-amber-600">例如：{{ droppedSample }}…</p>
        <p class="mt-1">如果你粘的其实是一份词表，用下面任一按钮找回：</p>
        <div class="mt-2 flex flex-wrap gap-1.5">
          <button class="rounded-lg bg-amber-600 px-2.5 py-1 text-[11px] font-medium text-white"
                  @click="useLinesMode">
            改用词表模式（全部保留）
          </button>
          <button v-if="settings.s.filterStopwords"
                  class="rounded-lg bg-white px-2.5 py-1 text-[11px] font-medium text-amber-700 ring-1 ring-amber-300"
                  @click="keepStopwords">
            不过滤高频词
          </button>
        </div>
      </div>

      <div class="max-h-[46vh] space-y-1.5 overflow-y-auto pr-0.5">
        <div
          v-for="(e, i) in preview.entries"
          :key="i"
          class="flex items-center gap-2 rounded-xl bg-slate-50 px-2.5 py-2"
        >
          <button
            class="flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 transition"
            :class="e.checked ? 'border-brand-600 bg-brand-600' : 'border-slate-300'"
            @click="e.checked = !e.checked"
          >
            <svg v-if="e.checked" class="h-3 w-3 text-white" fill="none" stroke="currentColor"
                 stroke-width="3.5" viewBox="0 0 24 24">
              <path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
          <input
            v-model="e.word"
            class="w-[38%] shrink-0 border-0 bg-transparent p-0 text-[15px] font-medium text-slate-800 outline-none"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
          />
          <input
            v-model="e.zh"
            class="min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-slate-600 outline-none placeholder:text-slate-300"
            placeholder="中文（留空自动查）"
          />
          <button class="shrink-0 rounded p-1 text-slate-300 active:text-rose-500"
                  @click="preview.entries.splice(i, 1)">
            ✕
          </button>
        </div>
      </div>

      <details v-if="preview.skipped.length" class="rounded-xl bg-rose-50/60 px-3 py-2">
        <summary class="cursor-pointer text-xs text-rose-600">
          {{ preview.skipped.length }} 行没能解析，点开检查
        </summary>
        <ul class="mt-1.5 max-h-28 space-y-0.5 overflow-y-auto">
          <li v-for="(s, i) in preview.skipped.slice(0, 60)" :key="i"
              class="truncate text-[11px] text-rose-500">{{ s }}</li>
        </ul>
      </details>

      <button class="btn-primary w-full py-3" :disabled="importing || !checkedEntries.length" @click="commit">
        {{ importing ? '导入中…' : `导入到「${targetGroups.map(vocab.groupName).join('、')}」` }}
      </button>
      <p v-if="settings.s.autoEnrich" class="text-center text-[11px] text-slate-400">
        导入后会自动联网补音标、发音和释义，可在设置里关掉
      </p>
    </section>
  </div>
</template>
