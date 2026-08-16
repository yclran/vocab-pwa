<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import * as repo from '../db/repo.js'
import { chineseText, englishText, hasChinese } from '../services/dict/index.js'
import { masteryOf, dueText } from '../services/srs.js'
import { pronounce } from '../services/speech.js'
import { useVocabStore } from '../stores/vocab.js'
import { useUiStore } from '../stores/ui.js'
import { useSettingsStore } from '../stores/settings.js'
import WordDetailSheet from '../components/WordDetailSheet.vue'

const route = useRoute()
const router = useRouter()
const vocab = useVocabStore()
const ui = useUiStore()
const settings = useSettingsStore()

const currentGroup = ref(route.params.groupId || '')
const search = ref('')
const words = ref([])
const loading = ref(false)
const detailKey = ref(null)

/* 多选 */
const selectMode = ref(false)
const selected = ref(new Set())
const selectedCount = computed(() => selected.value.size)
const batchDeleting = ref(false)
const groupDeleting = ref(false)

/* 当前列表里「还没拿到中文释义」或「没有真人发音」的词数量
 * （这些词要么添加时没联网，要么旧版本解析音频有 bug，需要重新查一遍） */
const pendingCount = computed(
  () => words.value.filter((w) => !hasChinese(w) || !(w.audio?.uk || w.audio?.us)).length
)
const hasPending = computed(() => pendingCount.value > 0)

/* 分组管理面板 */
const showGroupPanel = ref(false)
const newGroupName = ref('')
const renamingId = ref(null)
const renameDraft = ref('')

/* 批量移动面板 */
const showMovePanel = ref(false)

const MASTERY_TONE = {
  slate: 'bg-slate-100 text-slate-500',
  rose: 'bg-rose-50 text-rose-600',
  amber: 'bg-amber-50 text-amber-600',
  sky: 'bg-sky-50 text-sky-600',
  emerald: 'bg-emerald-50 text-emerald-600',
}

async function load() {
  loading.value = true
  words.value = await repo.listWords({
    groupId: currentGroup.value || null,
    search: search.value,
  })
  loading.value = false
  // 清掉已经不在列表里的选中项
  const keys = new Set(words.value.map((w) => w.key))
  selected.value = new Set([...selected.value].filter((k) => keys.has(k)))
}

onMounted(load)
watch([currentGroup, search], load)
watch(
  () => route.params.groupId,
  (v) => {
    if (v !== undefined && v !== currentGroup.value) currentGroup.value = v || ''
  }
)

function pickGroup(id) {
  currentGroup.value = id
  router.replace({ name: 'library', params: id ? { groupId: id } : {} })
}

function toggleSelect(key) {
  const s = new Set(selected.value)
  s.has(key) ? s.delete(key) : s.add(key)
  selected.value = s
}

function selectAll() {
  selected.value =
    selected.value.size === words.value.length
      ? new Set()
      : new Set(words.value.map((w) => w.key))
}

function exitSelect() {
  selectMode.value = false
  selected.value = new Set()
}

/* ------------------------------ 批量操作 ------------------------------ */

async function batchDelete() {
  const n = selected.value.size
  if (!n) return
  const ok = await ui.confirm({
    title: '批量删除',
    message: `确定删除选中的 ${n} 个单词？连同学习记录一起删除，不可撤销。`,
    confirmText: '删除',
    danger: true,
  })
  if (!ok) return
  batchDeleting.value = true
  try {
    await vocab.removeWords([...selected.value])
    ui.ok(`已删除 ${n} 个词`)
    exitSelect()
    await load()
  } finally {
    batchDeleting.value = false
  }
}

async function batchMove(groupId, copy) {
  const n = selected.value.size
  if (!n) return
  await vocab.moveTo([...selected.value], groupId, copy)
  ui.ok(`${n} 个词已${copy ? '加入' : '移动到'}「${vocab.groupName(groupId)}」`)
  showMovePanel.value = false
  exitSelect()
  await load()
}

async function batchEnrich() {
  const keys = selected.value.size ? [...selected.value] : words.value.map((w) => w.key)
  if (!keys.length) return
  await vocab.enrich(keys, { force: false })
  exitSelect()
  await load()
}

/* 一键把「缺失中文释义或缺失真人发音」的词重新联网拉取一遍（强制重查，
 * 这样旧版本解析出错的音频也能被修正） */
async function refetchMissing() {
  const keys = words.value
    .filter((w) => !hasChinese(w) || !(w.audio?.uk || w.audio?.us))
    .map((w) => w.key)
  if (!keys.length) {
    ui.ok('没有需要补全释义或发音的词')
    return
  }
  await vocab.enrich(keys, { force: true })
  await load()
  ui.ok(`已重新联网补全 ${keys.length} 个词的释义与发音`)
}

function download(name, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function exportTxt() {
  const text = await repo.exportTXT(currentGroup.value || null, { withZh: true })
  if (!text) return ui.warn('没有可导出的单词')
  const gname = currentGroup.value ? vocab.groupName(currentGroup.value) : '全部单词'
  const date = new Date().toISOString().slice(0, 10)
  download(`${gname}_${date}.txt`, text)
  ui.ok('已导出 TXT')
}

/* ------------------------------ 分组管理 ------------------------------ */

async function createGroup() {
  const name = newGroupName.value.trim()
  if (!name) return
  if (vocab.groups.some((g) => g.name === name)) return ui.warn('已有同名词本')
  await vocab.addGroup(name)
  newGroupName.value = ''
  ui.ok('词本已创建')
}

function startRename(g) {
  renamingId.value = g.id
  renameDraft.value = g.name
}

async function commitRename() {
  const name = renameDraft.value.trim()
  if (!name) return
  await vocab.rename(renamingId.value, name)
  renamingId.value = null
  ui.ok('已改名')
}

async function removeGroup(g) {
  if (g.builtin) return
  const ok = await ui.confirm({
    title: '删除词本',
    message: `删除词本「${g.name}」？\n\n里面的单词不会被删除，只是移出该词本；如果某个词删完后不属于任何词本，会自动放进「我的生词本」。`,
    confirmText: '删除',
    danger: true,
  })
  if (!ok) return
  groupDeleting.value = true
  try {
    await vocab.removeGroup(g.id)
    if (currentGroup.value === g.id) pickGroup('')
    ui.ok('词本已删除')
  } catch (e) {
    ui.err(e.message)
  } finally {
    groupDeleting.value = false
  }
}
</script>

<template>
  <div class="mx-auto max-w-lg">
    <!-- 分组横向筛选 -->
    <div class="sticky top-12 z-20 bg-slate-50/95 px-4 pb-2 pt-3 backdrop-blur">
      <div class="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1" style="scrollbar-width: none">
        <button
          class="chip shrink-0 ring-1 transition"
          :class="!currentGroup ? 'bg-brand-600 text-white ring-brand-600' : 'bg-white text-slate-600 ring-slate-200'"
          @click="pickGroup('')"
        >
          全部 {{ vocab.totalWords }}
        </button>
        <button
          v-for="g in vocab.groups"
          :key="g.id"
          class="chip shrink-0 ring-1 transition"
          :class="currentGroup === g.id ? 'bg-brand-600 text-white ring-brand-600' : 'bg-white text-slate-600 ring-slate-200'"
          @click="pickGroup(g.id)"
        >
          {{ g.name }} {{ vocab.counts[g.id] || 0 }}
        </button>
        <button
          class="chip shrink-0 bg-white text-slate-400 ring-1 ring-dashed ring-slate-300"
          @click="showGroupPanel = true"
        >
          管理
        </button>
      </div>

      <!-- 搜索 -->
      <div class="mt-2 flex gap-2">
        <div class="relative flex-1">
          <input
            v-model="search"
            class="input pl-9"
            placeholder="搜索单词或中文释义"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
          />
          <svg class="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
               fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" stroke-linecap="round" />
          </svg>
          <button
            v-if="search"
            class="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400"
            @click="search = ''"
          >
            ✕
          </button>
        </div>
        <button
          class="btn-ghost shrink-0 px-3"
          :class="selectMode ? 'text-brand-600 ring-brand-300' : ''"
          @click="selectMode ? exitSelect() : (selectMode = true)"
        >
          {{ selectMode ? '取消' : '多选' }}
        </button>
      </div>

      <!-- 一键补全：把添加时没联网拿到释义的词重新拉取一遍 -->
      <button
        v-if="hasPending"
        class="mt-2 flex w-full items-center justify-center gap-2 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition active:bg-brand-700 disabled:opacity-70"
        :disabled="vocab.enriching"
        @click="refetchMissing"
      >
        <svg
          class="h-4 w-4"
          :class="vocab.enriching ? 'animate-spin' : ''"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          viewBox="0 0 24 24"
        >
          <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h5M20 20v-5h-5" />
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M5.5 9a8 8 0 0113.5-2.5M18.5 15A8 8 0 014.5 17.5"
          />
        </svg>
        <span v-if="!vocab.enriching">联网补全 {{ pendingCount }} 个词的释义与发音</span>
        <span v-else>补全中… {{ vocab.enriching.done }}/{{ vocab.enriching.total }}</span>
      </button>
    </div>

    <!-- 列表 -->
    <div class="space-y-2 px-4 pb-4" :class="selectMode && selectedCount ? 'pb-24' : ''">
      <div v-if="loading" class="py-12 text-center text-sm text-slate-400">加载中…</div>

      <div v-else-if="!words.length" class="card mt-4 p-8 text-center">
        <p class="text-sm text-slate-500">
          {{ search ? '没有匹配的单词' : '这个词本还是空的' }}
        </p>
        <button v-if="!search" class="btn-soft mx-auto mt-3" @click="router.push({ name: 'import' })">
          去导入单词
        </button>
      </div>

      <div
        v-for="w in words"
        :key="w.key"
        class="card flex items-center gap-3 px-3.5 py-3 transition active:bg-slate-50"
        @click="selectMode ? toggleSelect(w.key) : (detailKey = w.key)"
      >
        <!-- 勾选框 -->
        <div
          v-if="selectMode"
          class="flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 transition"
          :class="selected.has(w.key) ? 'border-brand-600 bg-brand-600' : 'border-slate-300'"
        >
          <svg v-if="selected.has(w.key)" class="h-3 w-3 text-white" fill="none" stroke="currentColor"
               stroke-width="3.5" viewBox="0 0 24 24">
            <path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </div>

        <div class="min-w-0 flex-1">
          <div class="flex items-baseline gap-2">
            <span class="truncate text-[16px] font-medium text-slate-900">{{ w.word }}</span>
            <span v-if="w.phonetics.us || w.phonetics.uk" class="phonetic shrink-0 text-[11px] text-slate-400">
              {{ w.phonetics.us || w.phonetics.uk }}
            </span>
          </div>
          <p v-if="chineseText(w)" class="mt-0.5 truncate text-[13px] text-slate-600">
            {{ chineseText(w) }}
          </p>
          <p v-else-if="englishText(w, 1)" class="mt-0.5 truncate text-[13px] italic text-slate-400">
            {{ englishText(w, 1) }}
          </p>
          <p v-else class="mt-0.5 text-[12px] text-amber-600">
            {{ w.dictStatus === 'pending' ? '待联网补全' : '暂无释义，点击可手动填写' }}
          </p>
        </div>

        <div class="flex shrink-0 flex-col items-end gap-1">
          <span class="chip px-2 py-0.5 text-[10px]" :class="MASTERY_TONE[masteryOf(w.srs).tone]">
            {{ masteryOf(w.srs).text }}
          </span>
          <span class="text-[10px] text-slate-400">{{ dueText(w.srs?.due) }}</span>
        </div>

        <button
          v-if="!selectMode"
          class="shrink-0 rounded-lg p-1.5 text-brand-500 active:bg-brand-50"
          aria-label="朗读"
          @click.stop="pronounce(w, { accent: settings.s.accent, rate: settings.s.speakRate })"
        >
          <svg class="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
            <path d="M3 10v4h4l5 4V6L7 10H3zm13.5 2a4.5 4.5 0 00-2.5-4v8a4.5 4.5 0 002.5-4z" />
          </svg>
        </button>
      </div>

      <!-- 底部工具 -->
      <div v-if="words.length && !selectMode" class="flex gap-2 pt-2">
        <button class="btn-ghost flex-1 text-xs" @click="exportTxt">导出 TXT 备份</button>
        <button class="btn-ghost flex-1 text-xs" @click="batchEnrich">补全本组释义</button>
      </div>
    </div>

    <!-- 多选操作条 -->
    <Transition name="page">
      <div
        v-if="selectMode"
        class="safe-bottom fixed inset-x-0 bottom-[60px] z-30 border-t border-slate-200 bg-white/97 px-4 py-2.5 backdrop-blur"
      >
        <div class="mx-auto flex max-w-lg items-center gap-2">
          <button class="btn-ghost px-3 text-xs" @click="selectAll">
            {{ selectedCount === words.length && words.length ? '取消全选' : '全选' }}
          </button>
          <span class="text-xs text-slate-500">已选 {{ selectedCount }}</span>
          <div class="flex-1" />
          <button class="btn-ghost px-3 text-xs" :disabled="!selectedCount" @click="showMovePanel = true">
            移动
          </button>
          <button class="btn-ghost px-3 text-xs" :disabled="!selectedCount || batchDeleting" @click="batchEnrich">
            补全
          </button>
          <button
            class="btn-danger px-3 text-xs"
            :disabled="!selectedCount || batchDeleting"
            @click="batchDelete"
          >
            删除
          </button>
        </div>
      </div>
    </Transition>

    <!-- 移动到分组 -->
    <Teleport to="body">
      <div v-if="showMovePanel" class="fixed inset-0 z-40 flex items-end" @click.self="showMovePanel = false">
        <div class="absolute inset-0 bg-slate-900/40" @click="showMovePanel = false" />
        <div class="safe-bottom relative w-full rounded-t-3xl bg-white p-5">
          <h3 class="text-base font-semibold text-slate-900">
            把 {{ selectedCount }} 个词放到
          </h3>
          <p class="mt-1 text-xs text-slate-500">
            「移动」会替换原有归属，「加入」保留原词本、额外挂一个
          </p>
          <div class="mt-3 space-y-2">
            <div v-for="g in vocab.groups" :key="g.id" class="flex items-center gap-2">
              <span class="flex-1 truncate text-sm text-slate-700">{{ g.name }}</span>
              <button class="btn-ghost px-3 py-1.5 text-xs" @click="batchMove(g.id, true)">加入</button>
              <button class="btn-soft px-3 py-1.5 text-xs" @click="batchMove(g.id, false)">移动</button>
            </div>
          </div>
          <button class="btn-ghost mt-4 w-full" @click="showMovePanel = false">取消</button>
        </div>
      </div>
    </Teleport>

    <!-- 分组管理 -->
    <Teleport to="body">
      <div v-if="showGroupPanel" class="fixed inset-0 z-40 flex items-end" @click.self="showGroupPanel = false">
        <div class="absolute inset-0 bg-slate-900/40" @click="showGroupPanel = false" />
        <div class="safe-bottom relative max-h-[80vh] w-full overflow-y-auto rounded-t-3xl bg-white p-5">
          <h3 class="text-base font-semibold text-slate-900">词本管理</h3>

          <div class="mt-3 flex gap-2">
            <input v-model="newGroupName" class="input flex-1" placeholder="新词本名称，如：八年级上册"
                   @keyup.enter="createGroup" />
            <button class="btn-primary shrink-0" :disabled="!newGroupName.trim()" @click="createGroup">
              新建
            </button>
          </div>

          <div class="mt-4 space-y-2">
            <div v-for="g in vocab.groups" :key="g.id" class="flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-2.5">
              <template v-if="renamingId === g.id">
                <input v-model="renameDraft" class="input flex-1 py-1.5" @keyup.enter="commitRename" />
                <button class="btn-soft px-3 py-1.5 text-xs" @click="commitRename">保存</button>
                <button class="btn-ghost px-3 py-1.5 text-xs" @click="renamingId = null">取消</button>
              </template>
              <template v-else>
                <div class="min-w-0 flex-1">
                  <p class="truncate text-sm font-medium text-slate-800">{{ g.name }}</p>
                  <p class="text-[11px] text-slate-400">
                    {{ vocab.counts[g.id] || 0 }} 个词<span v-if="g.builtin"> · 内置</span>
                  </p>
                </div>
                <button class="btn-ghost px-3 py-1.5 text-xs" @click="startRename(g)">改名</button>
                <button
                  class="btn-danger px-3 py-1.5 text-xs"
                  :disabled="g.builtin || groupDeleting"
                  :title="g.builtin ? '内置词本不可删除，但可以改名' : ''"
                  @click="removeGroup(g)"
                >
                  删除
                </button>
              </template>
            </div>
          </div>

          <button class="btn-ghost mt-4 w-full" @click="showGroupPanel = false">完成</button>
        </div>
      </div>
    </Teleport>

    <WordDetailSheet v-model="detailKey" @changed="load(); vocab.refresh()" />
  </div>
</template>
