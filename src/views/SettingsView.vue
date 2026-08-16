<script setup>
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import * as repo from '../db/repo.js'
import { getDB, DB_NAME } from '../db/schema.js'
import { checkStatus } from '../services/dict/index.js'
import { listEnglishVoices, speak, ttsSupported, unlockTTS } from '../services/speech.js'
import { useSettingsStore } from '../stores/settings.js'
import { useVocabStore } from '../stores/vocab.js'
import { useUiStore } from '../stores/ui.js'

const router = useRouter()
const settings = useSettingsStore()
const vocab = useVocabStore()
const ui = useUiStore()

const proxy = ref({ loading: true, configured: false, provider: 'none', note: '' })
const voices = ref([])
const restoreInput = ref(null)
const installEvent = ref(null)
const storage = ref(null)

onMounted(async () => {
  checkStatus()
    .then((s) => (proxy.value = { loading: false, ...s }))
    .catch(() => (proxy.value = { loading: false, configured: false, provider: 'none' }))

  if (ttsSupported()) voices.value = await listEnglishVoices()

  if (navigator.storage?.estimate) {
    const e = await navigator.storage.estimate()
    storage.value = {
      used: (e.usage / 1024 / 1024).toFixed(1),
      quota: (e.quota / 1024 / 1024).toFixed(0),
    }
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    installEvent.value = e
  })
})

function testVoice() {
  unlockTTS()
  speak('Hello, this is a test of the pronunciation.', {
    accent: settings.s.accent,
    rate: settings.s.speakRate,
  })
}

/* ------------------------------ 备份 ------------------------------ */

function download(name, text, type = 'application/json') {
  const blob = new Blob([text], { type: `${type};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function backupJSON() {
  ui.setBusy('正在打包…')
  try {
    const data = await repo.exportJSON()
    const date = new Date().toISOString().slice(0, 10)
    download(`背单词备份_${date}.json`, JSON.stringify(data))
    ui.ok(`已导出 ${data.words.length} 个单词`)
  } finally {
    ui.setBusy(null)
  }
}

async function backupTXT() {
  const text = await repo.exportTXT(null, { withZh: true })
  if (!text) return ui.warn('词库是空的')
  download(`背单词全部_${new Date().toISOString().slice(0, 10)}.txt`, text, 'text/plain')
  ui.ok('已导出 TXT')
}

async function onRestore(e) {
  const file = e.target.files?.[0]
  e.target.value = ''
  if (!file) return

  const merge = await ui.confirm({
    title: '恢复方式',
    message:
      '【确定】= 合并（保留本机已有单词和学习进度，只补充缺的）\n【取消】= 覆盖（清空本机所有数据后再导入）',
    confirmText: '合并',
    cancelText: '覆盖',
  })
  if (!merge) {
    const ok = await ui.confirm({
      title: '覆盖确认',
      message: '⚠️ 覆盖会清空本机现有的全部单词和学习记录，且不可撤销。确定继续？',
      confirmText: '覆盖导入',
      danger: true,
    })
    if (!ok) return
  }

  ui.setBusy('正在恢复…')
  try {
    const payload = JSON.parse(await file.text())
    const r = await repo.importJSON(payload, { merge })
    await vocab.refresh()
    ui.ok(`恢复完成：新增 ${r.added}，合并 ${r.updated}`)
  } catch (err) {
    ui.err(`恢复失败：${err.message}`)
  } finally {
    ui.setBusy(null)
  }
}

async function wipe() {
  const ok = await ui.confirm({
    title: '清空全部数据',
    message: '⚠️ 这会删除本机全部单词、分组和学习记录，且无法撤销。\n\n建议先导出一份备份。',
    confirmText: '确认清空',
    danger: true,
  })
  if (!ok) return
  const ok2 = await ui.confirm({
    title: '再次确认',
    message: '再确认一次：真的要清空所有数据吗？',
    confirmText: '清空',
    danger: true,
  })
  if (!ok2) return
  const db = await getDB()
  db.close()
  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME)
    req.onsuccess = req.onerror = req.onblocked = resolve
  })
  localStorage.clear()
  location.reload()
}

async function install() {
  if (!installEvent.value) return
  installEvent.value.prompt()
  const { outcome } = await installEvent.value.userChoice
  if (outcome === 'accepted') ui.ok('已添加到桌面')
  installEvent.value = null
}
</script>

<template>
  <div class="mx-auto max-w-lg space-y-4 p-4">
    <!-- 发音 -->
    <section class="card divide-y divide-slate-100">
      <h2 class="px-4 pb-2 pt-3.5 text-sm font-semibold text-slate-900">发音与朗读</h2>

      <div class="flex items-center justify-between px-4 py-3">
        <span class="text-sm text-slate-700">口音</span>
        <div class="flex gap-1 rounded-lg bg-slate-100 p-0.5">
          <button
            v-for="a in [{ v: 'us', t: '美音' }, { v: 'uk', t: '英音' }]"
            :key="a.v"
            class="rounded-md px-3 py-1 text-xs font-medium transition"
            :class="settings.s.accent === a.v ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'"
            @click="settings.s.accent = a.v"
          >
            {{ a.t }}
          </button>
        </div>
      </div>

      <label class="flex items-center justify-between px-4 py-3">
        <span class="text-sm text-slate-700">出现单词时自动朗读</span>
        <input v-model="settings.s.autoPlay" type="checkbox" class="h-5 w-5 accent-brand-600" />
      </label>

      <div class="px-4 py-3">
        <div class="flex justify-between text-sm text-slate-700">
          <span>整词语速</span><span class="text-slate-500">{{ settings.s.speakRate.toFixed(2) }}×</span>
        </div>
        <input v-model.number="settings.s.speakRate" type="range" min="0.5" max="1.3" step="0.05"
               class="mt-2 w-full accent-brand-600" />
      </div>

      <div class="px-4 py-3">
        <div class="flex justify-between text-sm text-slate-700">
          <span>拼读语速</span><span class="text-slate-500">{{ settings.s.spellRate.toFixed(2) }}×</span>
        </div>
        <input v-model.number="settings.s.spellRate" type="range" min="0.4" max="1" step="0.05"
               class="mt-2 w-full accent-brand-600" />
        <p class="mt-1 text-[11px] text-slate-400">读音节时放慢，孩子更容易跟读</p>
      </div>

      <div class="flex items-center justify-between px-4 py-3">
        <div>
          <p class="text-sm text-slate-700">拼读循环次数</p>
          <p class="text-[11px] text-slate-400">点一次拼读，重复几遍</p>
        </div>
        <div class="flex gap-1 rounded-lg bg-slate-100 p-0.5">
          <button
            v-for="n in [1, 2, 3]"
            :key="n"
            class="rounded-md px-3 py-1 text-xs font-medium transition"
            :class="settings.s.spellLoops === n ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'"
            @click="settings.s.spellLoops = n"
          >
            {{ n }}
          </button>
        </div>
      </div>

      <div class="px-4 py-3">
        <button class="btn-ghost w-full text-xs" @click="testVoice">试听当前设置</button>
        <p v-if="!voices.length" class="mt-2 text-[11px] leading-relaxed text-amber-600">
          没有检测到英文语音包，拼读功能会失效。安卓可在「设置 → 语言和输入 → 文字转语音」里下载英文语音；
          iOS 一般自带。有真人 mp3 的单词不受影响。
        </p>
        <p v-else class="mt-2 text-[11px] text-slate-400">
          检测到 {{ voices.length }} 个英文语音包
        </p>
      </div>
    </section>

    <!-- 学习 -->
    <section class="card divide-y divide-slate-100">
      <h2 class="px-4 pb-2 pt-3.5 text-sm font-semibold text-slate-900">学习</h2>

      <div class="px-4 py-3">
        <div class="flex justify-between text-sm text-slate-700">
          <span>每轮默认词量</span><span class="text-slate-500">{{ settings.s.sessionSize }} 个</span>
        </div>
        <input v-model.number="settings.s.sessionSize" type="range" min="5" max="60" step="5"
               class="mt-2 w-full accent-brand-600" />
      </div>

      <label class="flex items-center justify-between px-4 py-3">
        <div>
          <p class="text-sm text-slate-700">卡片正面显示英文</p>
          <p class="text-[11px] text-slate-400">关掉则先看中文回忆英文</p>
        </div>
        <input v-model="settings.s.showEnglishFirst" type="checkbox" class="h-5 w-5 accent-brand-600" />
      </label>
    </section>

    <!-- 导入与词典 -->
    <section class="card divide-y divide-slate-100">
      <h2 class="px-4 pb-2 pt-3.5 text-sm font-semibold text-slate-900">导入与词典</h2>

      <label class="flex items-center justify-between px-4 py-3">
        <div>
          <p class="text-sm text-slate-700">导入后自动联网补全</p>
          <p class="text-[11px] text-slate-400">音标、发音、词性、释义</p>
        </div>
        <input v-model="settings.s.autoEnrich" type="checkbox" class="h-5 w-5 accent-brand-600" />
      </label>

      <label class="flex items-center justify-between px-4 py-3">
        <div>
          <p class="text-sm text-slate-700">整篇文章提词时过滤虚词</p>
          <p class="text-[11px] text-slate-400">the / of / and 这类不入库</p>
        </div>
        <input v-model="settings.s.filterStopwords" type="checkbox" class="h-5 w-5 accent-brand-600" />
      </label>

      <div class="px-4 py-3">
        <p class="text-sm text-slate-700">数据来源</p>
        <ul class="mt-1.5 space-y-1 text-[11px] leading-relaxed text-slate-500">
          <li>· 音标 / 英美发音 / 词性 / 英文释义：Free Dictionary API（免费直连，无需配置）</li>
          <li>· 音节拆分：本地算法，不联网也能用</li>
          <li>
            · 中文释义：
            <span v-if="proxy.loading" class="text-slate-400">检测中…</span>
            <span v-else-if="proxy.configured" class="text-emerald-600">
              翻译代理已配置（{{ proxy.provider }}）
            </span>
            <span v-else class="text-amber-600">未配置翻译代理</span>
          </li>
        </ul>
        <p v-if="!proxy.loading && !proxy.configured" class="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-700">
          Free Dictionary 只提供英文释义。要自动出中文，需要在项目根目录 <code>.env.local</code> 里
          填有道或百度翻译的 key（参见 <code>.env.example</code>）。<br />
          没配也能用：导入时用「单词 中文」格式自带释义，或在词条详情里手动填。
        </p>
      </div>
    </section>

    <!-- 备份 -->
    <section class="card divide-y divide-slate-100">
      <h2 class="px-4 pb-2 pt-3.5 text-sm font-semibold text-slate-900">备份与同步</h2>

      <div class="space-y-2 px-4 py-3">
        <p class="text-[11px] leading-relaxed text-slate-500">
          数据只存在这台设备的浏览器里，换手机、清理浏览器数据都会丢。
          几个人之间也不会自动同步——想共享词库就导出 JSON 发给对方，对方选「合并」恢复。
        </p>
        <div class="grid grid-cols-2 gap-2">
          <button class="btn-ghost text-xs" @click="backupJSON">导出 JSON 备份</button>
          <button class="btn-ghost text-xs" @click="backupTXT">导出 TXT 词表</button>
        </div>
        <button class="btn-soft w-full text-xs" @click="restoreInput.click()">从 JSON 备份恢复</button>
        <input ref="restoreInput" type="file" accept=".json,application/json" class="hidden" @change="onRestore" />
      </div>

      <div v-if="storage" class="px-4 py-3">
        <div class="flex justify-between text-[11px] text-slate-500">
          <span>本地已用空间</span>
          <span>{{ storage.used }} MB / 约 {{ storage.quota }} MB 可用</span>
        </div>
      </div>
    </section>

    <!-- PWA -->
    <section v-if="installEvent" class="card p-4">
      <h2 class="text-sm font-semibold text-slate-900">添加到桌面</h2>
      <p class="mt-1 text-[11px] text-slate-500">装到桌面后全屏运行，和 App 一样</p>
      <button class="btn-primary mt-2.5 w-full" @click="install">立即添加</button>
    </section>

    <!-- 危险操作 -->
    <section class="card p-4">
      <h2 class="text-sm font-semibold text-rose-600">清空全部数据</h2>
      <p class="mt-1 text-[11px] leading-relaxed text-slate-500">
        删除本机所有单词、分组和学习记录，不可撤销。请先导出备份。
      </p>
      <button class="btn-danger mt-2.5 w-full" @click="wipe">清空数据</button>
    </section>

    <div class="space-y-1 px-2 pb-4 text-center text-[11px] text-slate-400">
      <p>家庭自用背单词工具 · 数据全部保存在本机</p>
      <button class="text-brand-500" @click="router.back()">返回</button>
    </div>
  </div>
</template>
