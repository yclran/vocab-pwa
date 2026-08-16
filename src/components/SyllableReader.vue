<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { spellOut, stopSpeaking, ttsSupported } from '../services/speech.js'
import { syllabify } from '../services/syllable.js'
import { useSettingsStore } from '../stores/settings.js'

const props = defineProps({
  word: { type: [Object, String], required: true },
  compact: { type: Boolean, default: false },
})

const settings = useSettingsStore()

const active = ref(null) // 当前高亮的音节序号；-1 表示正在读整词
const playing = ref(false)
let stopFlag = false

const text = computed(() => (typeof props.word === 'string' ? props.word : props.word?.word || ''))

const parts = computed(() => {
  if (typeof props.word === 'object' && props.word?.syllables?.length) return props.word.syllables
  return syllabify(text.value)
})

const supported = ttsSupported()

watch(text, () => stop())

async function play() {
  if (playing.value) return stop()
  stopFlag = false
  playing.value = true
  try {
    await spellOut(props.word, {
      accent: settings.s.accent,
      rate: settings.s.spellRate,
      loops: settings.s.spellLoops,
      onSyllable: (i) => (active.value = i),
      shouldStop: () => stopFlag,
    })
  } finally {
    playing.value = false
    active.value = null
  }
}

function stop() {
  stopFlag = true
  stopSpeaking()
  playing.value = false
  active.value = null
}

onBeforeUnmount(stop)
</script>

<template>
  <div>
    <div class="flex flex-wrap items-center gap-1.5">
      <template v-for="(p, i) in parts" :key="i">
        <span
          class="rounded-lg px-2 py-1 font-medium transition"
          :class="[
            compact ? 'text-sm' : 'text-lg',
            active === i
              ? 'scale-110 bg-brand-600 text-white shadow'
              : 'bg-slate-100 text-slate-700',
          ]"
        >
          {{ p }}
        </span>
        <span v-if="i < parts.length - 1" class="text-slate-300">·</span>
      </template>

      <button
        class="ml-1 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition active:scale-95"
        :class="playing ? 'bg-rose-50 text-rose-600' : 'bg-brand-50 text-brand-700'"
        :disabled="!supported"
        @click="play"
      >
        <svg v-if="!playing" class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
          <path d="M8 5v14l11-7z" />
        </svg>
        <svg v-else class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
          <rect x="6" y="5" width="4" height="14" rx="1" />
          <rect x="14" y="5" width="4" height="14" rx="1" />
        </svg>
        {{ playing ? '停止' : '拼读' }}
      </button>
    </div>

    <p v-if="!supported" class="mt-1.5 text-[11px] text-amber-600">
      当前浏览器不支持语音合成，拼读功能不可用（建议用 Chrome / Safari）
    </p>
    <p v-else-if="active === -1" class="mt-1.5 text-[11px] text-brand-600">连读整词…</p>
  </div>
</template>
