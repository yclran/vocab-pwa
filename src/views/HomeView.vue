<script setup>
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useVocabStore } from '../stores/vocab.js'
import { useUiStore } from '../stores/ui.js'
import { enrichOne } from '../services/dict/index.js'
import * as repo from '../db/repo.js'
import WordDetailSheet from '../components/WordDetailSheet.vue'

const router = useRouter()
const vocab = useVocabStore()
const ui = useUiStore()

const newWord = ref('')
const targetGroup = ref('g_mine')
const adding = ref(false)
const detailKey = ref(null)

const COLOR = {
  emerald: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  blue: 'bg-blue-50 text-blue-700 ring-blue-200',
  rose: 'bg-rose-50 text-rose-700 ring-rose-200',
  amber: 'bg-amber-50 text-amber-700 ring-amber-200',
  slate: 'bg-slate-50 text-slate-700 ring-slate-200',
}

const greeting = computed(() => {
  const h = new Date().getHours()
  if (h < 6) return '夜深了'
  if (h < 11) return '早上好'
  if (h < 14) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
})

async function addOne() {
  const raw = newWord.value.trim()
  if (!raw) return
  if (!/^[a-zA-Z][a-zA-Z'’\- ]*$/.test(raw)) {
    ui.err('请输入英文单词')
    return
  }
  adding.value = true
  try {
    const res = await repo.addWordsBulk([raw], [targetGroup.value])
    await vocab.refresh()
    if (res.added === 0) {
      ui.warn(`「${raw}」已经在词库里了`)
    } else {
      ui.ok(`已添加「${raw}」，正在查词典…`)
    }
    newWord.value = ''
    const key = res.keys[0]
    const r = await enrichOne(key, { force: false })
    await vocab.refresh()
    if (r.reason === 'offline') {
      ui.warn('当前离线，联网后可在词库里补全释义')
    } else if (r.word?.dictStatus === 'failed') {
      ui.warn(`「${raw}」词典未收录，可手动填写释义`)
    }
    detailKey.value = key
  } catch (e) {
    ui.err(e.message)
  } finally {
    adding.value = false
  }
}
</script>

<template>
  <div class="mx-auto max-w-lg space-y-4 p-4">
    <!-- 今日概览 -->
    <section class="card overflow-hidden">
      <div class="bg-gradient-to-br from-brand-600 to-brand-500 px-5 py-4 text-white">
        <p class="text-xs text-white/75">{{ greeting }}</p>
        <p class="mt-0.5 text-[22px] font-semibold leading-tight">
          今天背了 {{ vocab.today.words }} 个词
        </p>
      </div>
      <div class="grid grid-cols-3 divide-x divide-slate-100">
        <div class="px-3 py-3 text-center">
          <p class="text-xl font-semibold text-slate-900">{{ vocab.totalWords }}</p>
          <p class="mt-0.5 text-[11px] text-slate-500">词库总量</p>
        </div>
        <div class="px-3 py-3 text-center">
          <p class="text-xl font-semibold" :class="vocab.dueCount ? 'text-brand-600' : 'text-slate-900'">
            {{ vocab.dueCount }}
          </p>
          <p class="mt-0.5 text-[11px] text-slate-500">待复习</p>
        </div>
        <div class="px-3 py-3 text-center">
          <p class="text-xl font-semibold text-slate-900">
            {{ vocab.today.total ? vocab.today.accuracy + '%' : '—' }}
          </p>
          <p class="mt-0.5 text-[11px] text-slate-500">今日正确率</p>
        </div>
      </div>
    </section>

    <!-- 开始学习 -->
    <button
      class="btn-primary w-full py-3.5 text-base"
      @click="router.push({ name: 'study' })"
    >
      {{ vocab.dueCount ? `开始复习 ${vocab.dueCount} 个词` : '开始学习' }}
    </button>

    <!-- 快速添加 -->
    <section class="card p-4">
      <h2 class="mb-2.5 text-sm font-semibold text-slate-900">快速添加单词</h2>
      <div class="flex gap-2">
        <input
          v-model="newWord"
          class="input flex-1"
          placeholder="输入英文单词，自动查音标释义"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
          @keyup.enter="addOne"
        />
        <button class="btn-primary shrink-0" :disabled="adding || !newWord.trim()" @click="addOne">
          {{ adding ? '查询中' : '添加' }}
        </button>
      </div>
      <div class="mt-2.5 flex flex-wrap gap-1.5">
        <button
          v-for="g in vocab.groups"
          :key="g.id"
          class="chip ring-1 transition"
          :class="targetGroup === g.id ? COLOR[g.color] || COLOR.slate : 'bg-white text-slate-500 ring-slate-200'"
          @click="targetGroup = g.id"
        >
          {{ g.name }}
        </button>
      </div>
    </section>

    <!-- 分组 -->
    <section>
      <div class="mb-2 flex items-center justify-between px-1">
        <h2 class="text-sm font-semibold text-slate-900">我的词本</h2>
        <button class="text-xs text-brand-600" @click="router.push({ name: 'library' })">
          全部 ›
        </button>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <button
          v-for="g in vocab.groups"
          :key="g.id"
          class="card p-3.5 text-left transition active:scale-[0.98]"
          @click="router.push({ name: 'library', params: { groupId: g.id } })"
        >
          <div class="flex items-start justify-between">
            <span class="chip ring-1" :class="COLOR[g.color] || COLOR.slate">
              {{ g.name }}
            </span>
          </div>
          <p class="mt-2.5 text-2xl font-semibold text-slate-900">{{ vocab.counts[g.id] || 0 }}</p>
          <p class="text-[11px] text-slate-400">个单词</p>
        </button>
      </div>
    </section>

    <p class="px-1 pb-2 pt-1 text-center text-[11px] leading-relaxed text-slate-400">
      数据保存在本机浏览器，换设备不会自动同步<br />
      重要词库请到「设置」里导出备份
    </p>

    <WordDetailSheet v-model="detailKey" @changed="vocab.refresh()" />
  </div>
</template>
