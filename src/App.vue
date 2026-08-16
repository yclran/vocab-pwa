<script setup>
import { computed, onMounted, ref } from 'vue'
import { RouterView, useRoute, useRouter } from 'vue-router'
import { useVocabStore } from './stores/vocab.js'
import { useSettingsStore } from './stores/settings.js'
import { useUiStore } from './stores/ui.js'
import ConfirmModal from './components/ConfirmModal.vue'

const route = useRoute()
const router = useRouter()
const vocab = useVocabStore()
const settings = useSettingsStore()
const ui = useUiStore()

const online = ref(navigator.onLine !== false)
const bootError = ref('')

const isFullscreen = computed(() => route.meta.fullscreen === true)

const tabs = [
  { name: 'home', label: '今日', icon: 'M3 12l9-9 9 9M5 10v10h14V10' },
  { name: 'library', label: '词库', icon: 'M4 5h16M4 12h16M4 19h10' },
  { name: 'import', label: '导入', icon: 'M12 4v12m0 0l-4-4m4 4l4-4M4 20h16' },
  { name: 'study', label: '学习', icon: 'M12 6.5C10 4.8 7.5 4.5 5 5v13c2.5-.5 5 0 7 1.5 2-1.5 4.5-2 7-1.5V5c-2.5-.5-5-.2-7 1.5zm0 0V20' },
]

onMounted(async () => {
  window.addEventListener('online', () => (online.value = true))
  window.addEventListener('offline', () => (online.value = false))
  try {
    await settings.load()
    await vocab.refresh()
  } catch (e) {
    bootError.value = e?.message || String(e)
  }
})

function go(name) {
  if (route.name !== name) router.push({ name })
}
</script>

<template>
  <div class="flex min-h-[100dvh] flex-col">
    <!-- 顶栏 -->
    <header
      v-if="!isFullscreen"
      class="safe-top sticky top-0 z-30 border-b border-slate-200/70 bg-white/85 backdrop-blur"
    >
      <div class="flex h-12 items-center justify-between px-4">
        <div class="flex items-center gap-2">
          <span class="text-[15px] font-semibold text-slate-900">
            {{ route.meta.title || '背单词' }}
          </span>
          <span
            v-if="!online"
            class="chip bg-amber-100 text-amber-700"
            title="离线状态下已缓存的单词仍可正常背诵，只是不能联网查新词"
          >
            离线
          </span>
        </div>
        <button
          class="rounded-lg p-1.5 text-slate-500 active:bg-slate-100"
          aria-label="设置"
          @click="router.push({ name: 'settings' })"
        >
          <svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.7" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="3" />
            <path
              d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 008 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.6 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.6a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9c.13.31.4.55.72.66H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"
            />
          </svg>
        </button>
      </div>

      <!-- 后台补全进度 -->
      <div v-if="vocab.enriching" class="px-4 pb-2">
        <div class="flex items-center justify-between text-[11px] text-slate-500">
          <span class="truncate">正在联网补全 {{ vocab.enriching.current }}</span>
          <span>{{ vocab.enriching.done }}/{{ vocab.enriching.total }}</span>
        </div>
        <div class="mt-1 h-1 overflow-hidden rounded-full bg-slate-200">
          <div
            class="h-full rounded-full bg-brand-500 transition-all"
            :style="{ width: `${(vocab.enriching.done / Math.max(vocab.enriching.total, 1)) * 100}%` }"
          />
        </div>
      </div>
    </header>

    <!-- 内容 -->
    <main class="flex-1" :class="isFullscreen ? '' : 'pb-20'">
      <div v-if="bootError" class="m-4 rounded-xl bg-rose-50 p-4 text-sm text-rose-700">
        <p class="font-medium">初始化失败</p>
        <p class="mt-1 break-all">{{ bootError }}</p>
        <p class="mt-2 text-xs text-rose-500">
          如果是隐私模式或浏览器禁用了本地存储，IndexedDB 不可用，本工具无法保存数据。
        </p>
      </div>
      <RouterView v-else v-slot="{ Component }">
        <Transition name="page" mode="out-in">
          <component :is="Component" />
        </Transition>
      </RouterView>
    </main>

    <!-- 底部导航 -->
    <nav
      v-if="!isFullscreen"
      class="safe-bottom fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 backdrop-blur"
    >
      <div class="mx-auto flex max-w-lg">
        <button
          v-for="t in tabs"
          :key="t.name"
          class="flex flex-1 flex-col items-center gap-0.5 py-2 transition active:scale-95"
          :class="route.name === t.name ? 'text-brand-600' : 'text-slate-400'"
          @click="go(t.name)"
        >
          <svg class="h-[22px] w-[22px]" fill="none" stroke="currentColor" stroke-width="1.7"
               stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
            <path :d="t.icon" />
          </svg>
          <span class="text-[10px] font-medium">{{ t.label }}</span>
        </button>
      </div>
    </nav>

    <!-- Toast -->
    <div class="pointer-events-none fixed inset-x-0 top-14 z-50 flex flex-col items-center gap-2 px-4">
      <TransitionGroup name="page">
        <div
          v-for="t in ui.toasts"
          :key="t.id"
          class="animate-fade-up max-w-sm rounded-xl px-4 py-2.5 text-sm shadow-lg"
          :class="{
            'bg-slate-900/92 text-white': t.type === 'info',
            'bg-emerald-600 text-white': t.type === 'success',
            'bg-rose-600 text-white': t.type === 'error',
            'bg-amber-500 text-white': t.type === 'warn',
          }"
        >
          {{ t.text }}
        </div>
      </TransitionGroup>
    </div>

    <!-- 全局确认弹窗 -->
    <ConfirmModal />

    <!-- 全屏遮罩（长任务） -->
    <div
      v-if="ui.busy"
      class="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm"
    >
      <div class="card mx-8 w-full max-w-xs p-5 text-center">
        <div class="mx-auto h-8 w-8 animate-spin rounded-full border-[3px] border-slate-200 border-t-brand-600" />
        <p class="mt-3 text-sm text-slate-700">{{ ui.busy.text }}</p>
        <div v-if="ui.busy.progress != null" class="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-200">
          <div class="h-full bg-brand-500 transition-all" :style="{ width: `${ui.busy.progress}%` }" />
        </div>
      </div>
    </div>
  </div>
</template>
