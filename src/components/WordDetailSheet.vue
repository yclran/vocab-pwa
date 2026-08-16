<script setup>
import { ref, watch } from 'vue'
import * as repo from '../db/repo.js'
import { enrichOne, setManualChinese, chineseText } from '../services/dict/index.js'
import { pronounce, stopSpeaking } from '../services/speech.js'
import { masteryOf, dueText } from '../services/srs.js'
import { useSettingsStore } from '../stores/settings.js'
import { useVocabStore } from '../stores/vocab.js'
import { useUiStore } from '../stores/ui.js'
import SyllableReader from './SyllableReader.vue'

const modelKey = defineModel({ type: String, default: null })
const emit = defineEmits(['changed'])

const settings = useSettingsStore()
const vocab = useVocabStore()
const ui = useUiStore()

const word = ref(null)
const loading = ref(false)
const editingZh = ref(false)
const zhDraft = ref('')
const deleting = ref(false)

watch(modelKey, async (k) => {
  stopSpeaking()
  editingZh.value = false
  deleting.value = false
  if (!k) {
    word.value = null
    return
  }
  loading.value = true
  word.value = await repo.getWord(k)
  loading.value = false
})

function close() {
  stopSpeaking()
  modelKey.value = null
}

async function reload() {
  word.value = await repo.getWord(modelKey.value)
  emit('changed')
}

async function requery() {
  loading.value = true
  const r = await enrichOne(modelKey.value, { force: true })
  loading.value = false
  if (r.reason === 'offline') ui.warn('当前离线，无法联网查词')
  else if (r.word?.dictStatus === 'failed') ui.warn(r.word.dictError || '词典未收录')
  else ui.ok('已更新')
  await reload()
}

function startEditZh() {
  zhDraft.value = word.value?.zhRaw || word.value?.zhAuto || ''
  editingZh.value = true
}

async function saveZh() {
  await setManualChinese(modelKey.value, zhDraft.value)
  editingZh.value = false
  ui.ok('释义已保存')
  await reload()
}

async function toggleGroup(gid) {
  const w = word.value
  const has = w.groups.includes(gid)
  let next = has ? w.groups.filter((g) => g !== gid) : [...w.groups, gid]
  if (next.length === 0) next = ['g_mine']
  w.groups = next
  await repo.putWord(w)
  await reload()
  vocab.refresh()
}

async function remove() {
  const ok = await ui.confirm({
    title: '删除单词',
    message: `确定删除「${word.value?.word}」？此操作不可撤销。`,
    confirmText: '删除',
    danger: true,
  })
  if (!ok) return
  deleting.value = true
  try {
    await repo.deleteWords([modelKey.value])
    ui.ok('已删除')
    close()
    emit('changed')
    vocab.refresh()
  } finally {
    deleting.value = false
  }
}

const STATUS_TEXT = {
  pending: { t: '待查询', c: 'bg-slate-100 text-slate-500' },
  ok: { t: '已联网补全', c: 'bg-emerald-50 text-emerald-600' },
  partial: { t: '部分补全', c: 'bg-amber-50 text-amber-600' },
  failed: { t: '词典未收录', c: 'bg-rose-50 text-rose-600' },
  manual: { t: '手动录入', c: 'bg-sky-50 text-sky-600' },
}
</script>

<template>
  <Teleport to="body">
    <Transition name="page">
      <div v-if="modelKey" class="fixed inset-0 z-40 flex items-end justify-center" @click.self="close">
        <div class="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]" @click="close" />

        <div class="safe-bottom relative max-h-[88vh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-white pb-4">
          <div class="sticky top-0 z-10 flex justify-center bg-white/95 pb-1 pt-2.5 backdrop-blur">
            <div class="h-1 w-10 rounded-full bg-slate-300" />
          </div>

          <div v-if="loading && !word" class="p-8 text-center text-sm text-slate-400">加载中…</div>

          <div v-else-if="word" class="space-y-4 px-5 pt-2">
            <!-- 词头 -->
            <div>
              <div class="flex items-start justify-between gap-3">
                <h2 class="text-[28px] font-semibold leading-tight text-slate-900">{{ word.word }}</h2>
                <span class="chip shrink-0" :class="STATUS_TEXT[word.dictStatus]?.c">
                  {{ STATUS_TEXT[word.dictStatus]?.t }}
                </span>
              </div>

              <!-- 音标 + 发音 -->
              <div class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5">
                <button
                  v-if="word.phonetics.uk"
                  class="flex items-center gap-1.5 text-sm text-slate-600 active:text-brand-600"
                  @click="pronounce(word, { accent: 'uk' })"
                >
                  <span class="text-[11px] font-semibold text-slate-400">英</span>
                  <span class="phonetic">{{ word.phonetics.uk }}</span>
                  <svg class="h-4 w-4 text-brand-500" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M3 10v4h4l5 4V6L7 10H3zm13.5 2a4.5 4.5 0 00-2.5-4v8a4.5 4.5 0 002.5-4z" />
                  </svg>
                </button>
                <button
                  v-if="word.phonetics.us"
                  class="flex items-center gap-1.5 text-sm text-slate-600 active:text-brand-600"
                  @click="pronounce(word, { accent: 'us' })"
                >
                  <span class="text-[11px] font-semibold text-slate-400">美</span>
                  <span class="phonetic">{{ word.phonetics.us }}</span>
                  <svg class="h-4 w-4 text-brand-500" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M3 10v4h4l5 4V6L7 10H3zm13.5 2a4.5 4.5 0 00-2.5-4v8a4.5 4.5 0 002.5-4z" />
                  </svg>
                </button>
                <span v-if="!word.phonetics.uk && !word.phonetics.us" class="text-sm text-slate-400">
                  暂无音标
                </span>
              </div>
            </div>

            <!-- 拼读 -->
            <div class="rounded-xl bg-slate-50 p-3">
              <p class="mb-2 text-[11px] font-medium text-slate-500">音节拼读</p>
              <SyllableReader :word="word" />
            </div>

            <!-- 中文释义 -->
            <div>
              <div class="mb-1.5 flex items-center justify-between">
                <p class="text-[11px] font-medium text-slate-500">中文释义</p>
                <button v-if="!editingZh" class="text-xs text-brand-600" @click="startEditZh">
                  {{ chineseText(word) ? '修改' : '手动填写' }}
                </button>
              </div>
              <div v-if="editingZh" class="space-y-2">
                <textarea v-model="zhDraft" rows="2" class="input" placeholder="例如：adj. 能够的；有能力的" />
                <div class="flex gap-2">
                  <button class="btn-primary flex-1" @click="saveZh">保存</button>
                  <button class="btn-ghost" @click="editingZh = false">取消</button>
                </div>
              </div>
              <p v-else-if="chineseText(word)" class="text-[15px] leading-relaxed text-slate-800">
                {{ chineseText(word) }}
                <span v-if="!word.zhRaw && word.zhAuto" class="ml-1 text-[10px] text-slate-400">机翻</span>
              </p>
              <p v-else class="text-sm text-slate-400">暂无中文，可手动填写</p>
            </div>

            <!-- 英文释义（按词性） -->
            <div v-if="word.meanings?.length">
              <p class="mb-1.5 text-[11px] font-medium text-slate-500">词性与英文释义</p>
              <div class="space-y-2">
                <div v-for="m in word.meanings" :key="m.pos" class="rounded-xl bg-slate-50 p-3">
                  <span class="chip bg-white text-[11px] font-semibold text-brand-700 ring-1 ring-slate-200">
                    {{ m.pos }}
                  </span>
                  <p v-if="m.zh?.length" class="mt-1.5 text-sm text-slate-800">{{ m.zh.join('；') }}</p>
                  <ul class="mt-1.5 space-y-1">
                    <li v-for="(e, i) in m.en.slice(0, 3)" :key="i" class="text-[13px] leading-snug text-slate-600">
                      · {{ e }}
                    </li>
                  </ul>
                </div>
              </div>
            </div>

            <!-- 例句 -->
            <div v-if="word.examples?.length">
              <p class="mb-1.5 text-[11px] font-medium text-slate-500">例句</p>
              <ul class="space-y-1.5">
                <li v-for="(ex, i) in word.examples.slice(0, 3)" :key="i"
                    class="rounded-lg bg-amber-50/60 px-3 py-2 text-[13px] italic leading-snug text-slate-700">
                  {{ ex.en }}
                </li>
              </ul>
            </div>

            <!-- 学习状态 -->
            <div class="flex items-center justify-between rounded-xl bg-slate-50 px-3.5 py-3">
              <div>
                <p class="text-[11px] text-slate-500">生疏度</p>
                <p class="text-sm font-medium text-slate-800">{{ masteryOf(word.srs).text }}</p>
              </div>
              <div class="text-right">
                <p class="text-[11px] text-slate-500">下次复习</p>
                <p class="text-sm font-medium text-slate-800">{{ dueText(word.srs?.due) }}</p>
              </div>
              <div class="text-right">
                <p class="text-[11px] text-slate-500">对/错</p>
                <p class="text-sm font-medium text-slate-800">
                  {{ word.stats?.correct || 0 }}/{{ word.stats?.wrong || 0 }}
                </p>
              </div>
            </div>

            <!-- 所属分组 -->
            <div>
              <p class="mb-1.5 text-[11px] font-medium text-slate-500">所属词本（可多选）</p>
              <div class="flex flex-wrap gap-1.5">
                <button
                  v-for="g in vocab.groups"
                  :key="g.id"
                  class="chip ring-1 transition"
                  :class="word.groups.includes(g.id)
                    ? 'bg-brand-600 text-white ring-brand-600'
                    : 'bg-white text-slate-500 ring-slate-200'"
                  @click="toggleGroup(g.id)"
                >
                  {{ g.name }}
                </button>
              </div>
            </div>

            <!-- 操作 -->
            <div class="flex gap-2 pt-1">
              <button class="btn-ghost flex-1" :disabled="loading || deleting" @click="requery">
                {{ loading ? '查询中…' : '重新联网查词' }}
              </button>
              <button class="btn-danger" :disabled="deleting" @click="remove">删除</button>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
