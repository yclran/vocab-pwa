<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import * as repo from '../db/repo.js'
import { useVocabStore } from '../stores/vocab.js'
import { useSettingsStore } from '../stores/settings.js'
import { useUiStore } from '../stores/ui.js'

const router = useRouter()
const vocab = useVocabStore()
const settings = useSettingsStore()
const ui = useUiStore()

const groupId = ref('')
const scope = ref('due')
const mode = ref('card')
const size = ref(settings.s.sessionSize)

const pool = ref({ due: 0, new: 0, all: 0, wrong: 0 })

const MODES = [
  {
    v: 'card',
    t: '翻转卡片',
    d: '正面英文+音标，翻面看中文',
    icon: 'M4 6h16v12H4z M4 10h16',
  },
  {
    v: 'syllable',
    t: '拼读跟读',
    d: '逐音节朗读再读整词，适合孩子',
    icon: 'M3 10v4h4l5 4V6L7 10H3z',
  },
  {
    v: 'choice-en2zh',
    t: '看英文选中文',
    d: '四选一，答错自动进错题本',
    icon: 'M4 7h16M4 12h10M4 17h7',
  },
  {
    v: 'choice-zh2en',
    t: '看中文选英文',
    d: '四选一，反向检验',
    icon: 'M4 7h7M4 12h10M4 17h16',
  },
  {
    v: 'spell',
    t: '拼写默写',
    d: '看中文手动拼出英文',
    icon: 'M5 19h14M7 15l8-8 2 2-8 8H7z',
  },
  {
    v: 'mix',
    t: '中英互测',
    d: '随机切换方向，综合检验',
    icon: 'M7 8h10l-3-3M17 16H7l3 3',
  },
]

const SCOPES = [
  { v: 'due', t: '待复习', hint: '到期该复习的词（推荐）' },
  { v: 'new', t: '只学新词', hint: '一次都没学过的词' },
  { v: 'wrong', t: '错题本', hint: '之前答错收进去的词' },
  { v: 'all', t: '全部', hint: '不限状态随机抽' },
]

async function calcPool() {
  const all = await repo.listWords({ groupId: groupId.value || null })
  const now = Date.now()
  pool.value = {
    all: all.length,
    due: all.filter((w) => (w.srs?.due ?? 0) <= now).length,
    new: all.filter((w) => !w.srs?.reps).length,
    wrong: all.filter((w) => w.groups.includes('g_wrong')).length,
  }
}

onMounted(calcPool)
watch(groupId, calcPool)

const available = computed(() => pool.value[scope.value] || 0)

const needsChinese = computed(() =>
  ['choice-en2zh', 'choice-zh2en', 'spell', 'mix'].includes(mode.value)
)

function start() {
  if (!available.value) {
    ui.warn('这个范围下没有可学的单词，换个范围或词本试试')
    return
  }
  settings.s.sessionSize = size.value
  router.push({
    name: 'session',
    query: {
      group: groupId.value || '',
      scope: scope.value,
      mode: mode.value,
      size: String(size.value),
    },
  })
}
</script>

<template>
  <div class="mx-auto max-w-lg space-y-4 p-4">
    <!-- 词本 -->
    <section class="card p-4">
      <h2 class="mb-2.5 text-sm font-semibold text-slate-900">学哪个词本</h2>
      <div class="flex flex-wrap gap-1.5">
        <button
          class="chip ring-1 transition"
          :class="!groupId ? 'bg-brand-600 text-white ring-brand-600' : 'bg-white text-slate-500 ring-slate-200'"
          @click="groupId = ''"
        >
          全部
        </button>
        <button
          v-for="g in vocab.groups"
          :key="g.id"
          class="chip ring-1 transition"
          :class="groupId === g.id ? 'bg-brand-600 text-white ring-brand-600' : 'bg-white text-slate-500 ring-slate-200'"
          @click="groupId = g.id"
        >
          {{ g.name }} {{ vocab.counts[g.id] || 0 }}
        </button>
      </div>
    </section>

    <!-- 范围 -->
    <section class="card p-4">
      <h2 class="mb-2.5 text-sm font-semibold text-slate-900">学习范围</h2>
      <div class="grid grid-cols-2 gap-2">
        <button
          v-for="s in SCOPES"
          :key="s.v"
          class="rounded-xl px-3 py-2.5 text-left ring-1 transition"
          :class="scope === s.v ? 'bg-brand-50 ring-brand-400' : 'bg-white ring-slate-200'"
          @click="scope = s.v"
        >
          <div class="flex items-baseline justify-between">
            <span class="text-sm font-medium" :class="scope === s.v ? 'text-brand-700' : 'text-slate-700'">
              {{ s.t }}
            </span>
            <span class="text-[13px] font-semibold" :class="pool[s.v] ? 'text-slate-900' : 'text-slate-300'">
              {{ pool[s.v] }}
            </span>
          </div>
          <p class="mt-0.5 text-[11px] leading-snug text-slate-400">{{ s.hint }}</p>
        </button>
      </div>
    </section>

    <!-- 题型 -->
    <section class="card p-4">
      <h2 class="mb-2.5 text-sm font-semibold text-slate-900">题型</h2>
      <div class="space-y-2">
        <button
          v-for="m in MODES"
          :key="m.v"
          class="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left ring-1 transition"
          :class="mode === m.v ? 'bg-brand-50 ring-brand-400' : 'bg-white ring-slate-200'"
          @click="mode = m.v"
        >
          <svg class="h-5 w-5 shrink-0" :class="mode === m.v ? 'text-brand-600' : 'text-slate-400'"
               fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"
               stroke-linejoin="round" viewBox="0 0 24 24">
            <path :d="m.icon" />
          </svg>
          <div class="min-w-0 flex-1">
            <p class="text-sm font-medium" :class="mode === m.v ? 'text-brand-700' : 'text-slate-700'">
              {{ m.t }}
            </p>
            <p class="text-[11px] text-slate-400">{{ m.d }}</p>
          </div>
        </button>
      </div>
      <p v-if="needsChinese" class="mt-2.5 rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-700">
        这个题型需要中文释义。没有中文的词会被跳过，可以先在词库里补全或手动填写。
      </p>
    </section>

    <!-- 数量 -->
    <section class="card p-4">
      <div class="flex items-center justify-between">
        <h2 class="text-sm font-semibold text-slate-900">每轮词量</h2>
        <span class="text-sm font-semibold text-brand-600">{{ size }} 个</span>
      </div>
      <input v-model.number="size" type="range" min="5" max="60" step="5" class="mt-3 w-full accent-brand-600" />
      <div class="flex justify-between text-[10px] text-slate-400">
        <span>5</span><span>30</span><span>60</span>
      </div>
    </section>

    <button class="btn-primary w-full py-3.5 text-base" @click="start">
      开始（本轮 {{ Math.min(size, available) }} 个词）
    </button>
    <div class="h-2" />
  </div>
</template>
