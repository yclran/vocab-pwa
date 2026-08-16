<script setup>
/**
 * 学习会话
 *
 * 六种题型共用一条流水线：
 *   取词 → 组卷 → 出题 → 判定 → 写 SRS/记录/错题本 → 下一题 → 结算
 *
 * 判定后的评级：
 *   主观题（卡片、拼读）由人自己点「生疏 / 一般 / 熟练」
 *   客观题（选择、拼写）自动映射：对 = 一般，错 = 生疏（当天 5 分钟后会再出现）
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import * as repo from '../db/repo.js'
import { chineseText, chineseShort, englishText } from '../services/dict/index.js'
import { review, reviewByResult, GRADE } from '../services/srs.js'
import { pronounce, stopSpeaking, unlockTTS } from '../services/speech.js'
import { useSettingsStore } from '../stores/settings.js'
import { useVocabStore } from '../stores/vocab.js'
import { useUiStore } from '../stores/ui.js'
import SyllableReader from '../components/SyllableReader.vue'

const route = useRoute()
const router = useRouter()
const settings = useSettingsStore()
const vocab = useVocabStore()
const ui = useUiStore()

const loading = ref(true)
const queue = ref([])
const index = ref(0)
const finished = ref(false)
const skippedNoZh = ref(0)

/* 当前题状态 */
const flipped = ref(false)
const answered = ref(false)
const lastCorrect = ref(null)
const picked = ref(null)
const typed = ref('')
const inputRef = ref(null)
const subMode = ref('') // mix 模式下本题的实际题型

/* 结算 */
const result = ref({ correct: 0, wrong: 0, words: [] })

const cur = computed(() => queue.value[index.value] || null)
const total = computed(() => queue.value.length)
const progress = computed(() => (total.value ? (index.value / total.value) * 100 : 0))

const baseMode = route.query.mode || 'card'
const effMode = computed(() => (baseMode === 'mix' ? subMode.value : baseMode))
const isChoice = computed(() => effMode.value.startsWith('choice'))

/* ------------------------------ 组卷 ------------------------------ */

function shuffle(arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function pickSubMode() {
  const pools = ['choice-en2zh', 'choice-zh2en', 'spell']
  return pools[Math.floor(Math.random() * pools.length)]
}

/** 干扰项池：整个词本里有中文的词 */
let distractPool = []

function buildOptions(word, direction) {
  // 选项用短释义：有道的完整释义常有几十字，铺在按钮里没法看
  const right = direction === 'en2zh' ? chineseShort(word) : word.word
  const others = shuffle(distractPool.filter((w) => w.key !== word.key)).slice(0, 12)
  const seen = new Set([right])
  const opts = [right]
  for (const o of others) {
    const v = direction === 'en2zh' ? chineseShort(o) : o.word
    if (!v || seen.has(v)) continue
    seen.add(v)
    opts.push(v)
    if (opts.length === 4) break
  }
  return { correct: right, options: shuffle(opts) }
}

async function build() {
  const groupId = route.query.group || null
  const scope = route.query.scope || 'due'
  const size = Math.max(1, parseInt(route.query.size, 10) || 20)

  const all = await repo.listWords({ groupId })
  distractPool = all.filter((w) => chineseText(w))

  const now = Date.now()
  let candidates = all
  if (scope === 'due') candidates = all.filter((w) => (w.srs?.due ?? 0) <= now)
  else if (scope === 'new') candidates = all.filter((w) => !w.srs?.reps)
  else if (scope === 'wrong') candidates = all.filter((w) => w.groups.includes('g_wrong'))

  // 需要中文的题型，把没中文的词剔掉并如实告知
  const needZh = ['choice-en2zh', 'choice-zh2en', 'spell', 'mix'].includes(baseMode)
  if (needZh) {
    const before = candidates.length
    candidates = candidates.filter((w) => chineseText(w))
    skippedNoZh.value = before - candidates.length
  }

  // 待复习优先按到期时间排，其它随机
  const ordered =
    scope === 'due'
      ? [...candidates].sort((a, b) => (a.srs?.due ?? 0) - (b.srs?.due ?? 0))
      : shuffle(candidates)

  queue.value = ordered.slice(0, size).map((w) => {
    const item = { word: w }
    if (baseMode !== 'mix') item.sub = baseMode
    return item
  })

  loading.value = false
  if (queue.value.length) prepare()
}

function prepare() {
  flipped.value = false
  answered.value = false
  lastCorrect.value = null
  picked.value = null
  typed.value = ''

  const item = cur.value
  if (!item) return
  subMode.value = item.sub || (item.sub = baseMode === 'mix' ? pickSubMode() : baseMode)

  if (isChoice.value) {
    const dir = effMode.value === 'choice-en2zh' ? 'en2zh' : 'zh2en'
    if (!item.quiz) item.quiz = buildOptions(item.word, dir)
    // 干扰项不够 4 个时降级成卡片题，避免出现"三选一必对"
    if (item.quiz.options.length < 3) {
      item.sub = 'card'
      subMode.value = 'card'
    }
  }

  if (effMode.value === 'spell') {
    nextTick(() => inputRef.value?.focus())
  }

  if (settings.s.autoPlay && ['card', 'syllable', 'choice-en2zh'].includes(effMode.value)) {
    pronounce(item.word, { accent: settings.s.accent, rate: settings.s.speakRate })
  }
}

/* ------------------------------ 判定与记录 ------------------------------ */

async function commitGrade(grade, correct) {
  const w = cur.value.word
  const fresh = (await repo.getWord(w.key)) || w

  fresh.srs = grade ? review(fresh.srs, grade) : reviewByResult(fresh.srs, correct)
  fresh.stats = fresh.stats || { seen: 0, correct: 0, wrong: 0 }
  fresh.stats.seen++
  if (correct === true) fresh.stats.correct++
  if (correct === false) fresh.stats.wrong++

  // 错题本：答错进，练到熟练自动出
  if (correct === false && !fresh.groups.includes('g_wrong')) {
    fresh.groups = [...fresh.groups, 'g_wrong']
  } else if (correct === true && fresh.groups.includes('g_wrong') && fresh.srs.level >= 6) {
    fresh.groups = fresh.groups.filter((g) => g !== 'g_wrong')
    if (!fresh.groups.length) fresh.groups = ['g_mine']
    ui.ok(`「${fresh.word}」已练熟，移出错题本`)
  }

  await repo.putWord(fresh)
  if (correct !== null) await repo.logRecord(w.key, effMode.value, correct)

  result.value.words.push({
    word: w.word,
    key: w.key,
    zh: chineseShort(w, 40),
    correct,
    grade: grade || (correct ? GRADE.NORMAL : GRADE.HARD),
  })
  if (correct === true) result.value.correct++
  if (correct === false) result.value.wrong++
}

/** 主观题：自己评级 */
async function grade(g) {
  if (answered.value) return
  answered.value = true
  const correct = g === GRADE.HARD ? false : g === GRADE.EASY ? true : null
  await commitGrade(g, correct)
  next()
}

/** 选择题 */
async function choose(opt) {
  if (answered.value) return
  picked.value = opt
  answered.value = true
  const ok = opt === cur.value.quiz.correct
  lastCorrect.value = ok
  await commitGrade(null, ok)
  if (ok) setTimeout(next, 620)
}

/** 拼写题 */
async function checkSpell() {
  if (answered.value) return
  const input = typed.value.trim().toLowerCase()
  if (!input) return
  answered.value = true
  const ok = input === cur.value.word.key
  lastCorrect.value = ok
  await commitGrade(null, ok)
  pronounce(cur.value.word, { accent: settings.s.accent, rate: settings.s.speakRate })
  if (ok) setTimeout(next, 700)
}

function next() {
  stopSpeaking()
  if (index.value + 1 >= total.value) {
    finished.value = true
    vocab.refresh()
    return
  }
  index.value++
  prepare()
}

async function exit() {
  if (!finished.value && index.value > 0) {
    const ok = await ui.confirm({
      title: '结束本轮学习',
      message: '已答过的进度会保留，确定结束吗？',
      confirmText: '结束',
    })
    if (!ok) return
  }
  stopSpeaking()
  vocab.refresh()
  router.push({ name: 'study' })
}

function restart() {
  index.value = 0
  finished.value = false
  result.value = { correct: 0, wrong: 0, words: [] }
  loading.value = true
  build()
}

onMounted(() => {
  unlockTTS()
  build()
})
onBeforeUnmount(stopSpeaking)

/** 取分词性中文释义列表；手工填写的 zhRaw 优先 */
function zhMeanings(word) {
  if (word?.zhRaw) return [{ pos: '', zh: [word.zhRaw] }]
  return (word?.meanings || []).filter((m) => m.zh?.length)
}

const GRADE_BTNS = [
  { g: GRADE.HARD, t: '生疏', hint: '5 分钟后再考', cls: 'bg-rose-50 text-rose-600 ring-rose-200' },
  { g: GRADE.NORMAL, t: '一般', hint: '按曲线推进', cls: 'bg-amber-50 text-amber-600 ring-amber-200' },
  { g: GRADE.EASY, t: '熟练', hint: '跳级，隔更久', cls: 'bg-emerald-50 text-emerald-600 ring-emerald-200' },
]
</script>

<template>
  <!--
    高度必须是确定值而不是 min-height：
    子元素的 flex-1 只有在父容器高度确定时才能真正分配剩余空间，
    否则卡片只会退化成 min-height 的大小并顶在页面上方。
  -->
  <div class="flex h-[100dvh] flex-col overflow-hidden bg-slate-50">
    <!-- 顶部进度 -->
    <header class="safe-top sticky top-0 z-20 bg-white/95 backdrop-blur">
      <div class="flex h-12 items-center gap-3 px-4">
        <button class="rounded-lg p-1.5 text-slate-500 active:bg-slate-100" @click="exit">
          <svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path d="M6 6l12 12M18 6L6 18" stroke-linecap="round" />
          </svg>
        </button>
        <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-200">
          <div class="h-full rounded-full bg-brand-500 transition-all duration-300"
               :style="{ width: `${finished ? 100 : progress}%` }" />
        </div>
        <span class="shrink-0 text-xs tabular-nums text-slate-500">
          {{ Math.min(index + 1, total) }}/{{ total }}
        </span>
      </div>
    </header>

    <!-- 加载 / 空 -->
    <div v-if="loading" class="flex flex-1 items-center justify-center text-sm text-slate-400">
      正在组卷…
    </div>

    <div v-else-if="!total" class="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
      <p class="text-sm text-slate-500">这个范围下没有可以出题的单词</p>
      <p v-if="skippedNoZh" class="text-xs text-amber-600">
        有 {{ skippedNoZh }} 个词因为缺中文释义被跳过，<br />可以到词库里补全或手动填写
      </p>
      <button class="btn-primary mt-2" @click="exit">返回</button>
    </div>

    <!-- 结算 -->
    <div v-else-if="finished" class="flex-1 overflow-y-auto p-4">
      <div class="mx-auto max-w-lg space-y-4">
        <section class="card overflow-hidden">
          <div class="bg-gradient-to-br from-brand-600 to-brand-500 px-5 py-5 text-center text-white">
            <p class="text-sm text-white/80">本轮完成</p>
            <p class="mt-1 text-4xl font-semibold">{{ total }}</p>
            <p class="mt-0.5 text-xs text-white/70">个单词</p>
          </div>
          <div class="grid grid-cols-3 divide-x divide-slate-100">
            <div class="py-3 text-center">
              <p class="text-xl font-semibold text-emerald-600">{{ result.correct }}</p>
              <p class="text-[11px] text-slate-500">答对</p>
            </div>
            <div class="py-3 text-center">
              <p class="text-xl font-semibold text-rose-500">{{ result.wrong }}</p>
              <p class="text-[11px] text-slate-500">答错</p>
            </div>
            <div class="py-3 text-center">
              <p class="text-xl font-semibold text-slate-900">
                {{ result.correct + result.wrong ? Math.round((result.correct / (result.correct + result.wrong)) * 100) + '%' : '—' }}
              </p>
              <p class="text-[11px] text-slate-500">正确率</p>
            </div>
          </div>
        </section>

        <section v-if="result.words.length" class="card p-4">
          <h3 class="mb-2 text-sm font-semibold text-slate-900">本轮明细</h3>
          <div class="max-h-72 space-y-1 overflow-y-auto">
            <div v-for="(r, i) in result.words" :key="i"
                 class="flex items-center gap-2 rounded-lg px-2 py-1.5"
                 :class="r.correct === false ? 'bg-rose-50' : 'bg-slate-50'">
              <span class="w-1.5 shrink-0 self-stretch rounded-full"
                    :class="r.correct === false ? 'bg-rose-400' : r.correct === true ? 'bg-emerald-400' : 'bg-slate-300'" />
              <span class="shrink-0 text-sm font-medium text-slate-800">{{ r.word }}</span>
              <span class="min-w-0 flex-1 truncate text-[12px] text-slate-500">{{ r.zh }}</span>
            </div>
          </div>
        </section>

        <p v-if="skippedNoZh" class="rounded-xl bg-amber-50 px-3 py-2 text-[11px] text-amber-700">
          另有 {{ skippedNoZh }} 个词缺中文释义，本轮没有出题
        </p>

        <div class="flex gap-2">
          <button class="btn-ghost flex-1" @click="exit">返回</button>
          <button class="btn-primary flex-1" @click="restart">再来一轮</button>
        </div>
      </div>
    </div>

    <!-- 答题区 -->
    <div v-else-if="cur" class="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-6 pt-3">
      <div class="mx-auto flex min-h-0 w-full max-w-lg flex-1 flex-col">

        <!-- 翻转卡片 -->
        <template v-if="effMode === 'card'">
          <div class="flip-scene min-h-[320px] flex-1" @click="flipped = !flipped">
            <div class="flip-inner" :class="{ 'is-flipped': flipped }">
              <!--
                每一面都是「可滚动容器 + min-h-full 的居中内层」。
                直接在滚动容器上写 justify-center，内容超高时顶部会被裁掉且滚不上去。
              -->
              <!-- 正面 -->
              <div class="flip-face card overflow-y-auto">
                <div class="flex min-h-full flex-col items-center justify-center gap-3 p-6">
                  <template v-if="settings.s.showEnglishFirst">
                    <p class="break-all text-center text-[34px] font-semibold leading-tight text-slate-900">
                      {{ cur.word.word }}
                    </p>
                    <p v-if="cur.word.phonetics.us || cur.word.phonetics.uk" class="phonetic text-sm text-slate-500">
                      {{ cur.word.phonetics.us || cur.word.phonetics.uk }}
                    </p>
                    <button
                      class="btn-soft mt-1"
                      @click.stop="pronounce(cur.word, { accent: settings.s.accent, rate: settings.s.speakRate })"
                    >
                      <svg class="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M3 10v4h4l5 4V6L7 10H3zm13.5 2a4.5 4.5 0 00-2.5-4v8a4.5 4.5 0 002.5-4z" />
                      </svg>
                      朗读
                    </button>
                  </template>
                  <template v-else>
                    <p class="text-[11px] text-slate-400">回忆对应的英文</p>
                    <p v-if="chineseText(cur.word)"
                       class="whitespace-pre-line text-center text-[19px] font-medium leading-snug text-slate-900">
                      {{ chineseText(cur.word) }}
                    </p>
                    <p v-else class="whitespace-pre-line text-center text-[15px] italic leading-relaxed text-slate-500">
                      {{ englishText(cur.word, 2) || '暂无释义' }}
                    </p>
                  </template>
                  <p class="pt-2 text-[11px] text-slate-300">点击卡片翻面</p>
                </div>
              </div>

              <!-- 背面 -->
              <div class="flip-face flip-back card overflow-y-auto">
                <div class="flex min-h-full flex-col justify-center gap-3 p-6">
                  <div class="text-center">
                    <p class="break-all text-xl font-medium text-slate-900">{{ cur.word.word }}</p>
                    <p v-if="cur.word.phonetics.us || cur.word.phonetics.uk" class="phonetic text-xs text-slate-500">
                      {{ cur.word.phonetics.us || cur.word.phonetics.uk }}
                    </p>
                    <div v-if="cur.word.exam?.length" class="mt-1.5 flex flex-wrap justify-center gap-1">
                      <span v-for="e in cur.word.exam.slice(0, 4)" :key="e"
                            class="rounded bg-brand-50 px-1.5 py-0.5 text-[10px] text-brand-600">{{ e }}</span>
                    </div>
                  </div>

                  <div class="flex justify-center" @click.stop>
                    <SyllableReader :word="cur.word" compact />
                  </div>

                  <!-- 分词性中文释义 -->
                  <div v-if="zhMeanings(cur.word).length" class="space-y-1.5">
                    <p v-for="(m, mi) in zhMeanings(cur.word)" :key="mi"
                       class="text-[15px] leading-relaxed text-slate-800">
                      <span v-if="m.pos && m.pos !== '—'"
                            class="mr-1 font-semibold text-brand-600">{{ m.pos }}</span>{{ m.zh.join('；') }}
                    </p>
                  </div>
                  <div v-else-if="englishText(cur.word, 2)"
                       class="whitespace-pre-line text-center text-[14px] italic leading-relaxed text-slate-500">
                    {{ englishText(cur.word, 2) }}
                  </div>
                  <p v-else class="text-center text-sm text-slate-400">暂无释义</p>

                  <!-- 英文释义作为补充 -->
                  <div v-if="zhMeanings(cur.word).length && englishText(cur.word, 1)"
                       class="border-t border-slate-100 pt-2 text-[12px] italic leading-relaxed text-slate-400">
                    {{ englishText(cur.word, 1) }}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="mt-4 grid grid-cols-3 gap-2">
            <button v-for="b in GRADE_BTNS" :key="b.g" class="btn ring-1 py-3" :class="b.cls" @click="grade(b.g)">
              <span class="flex flex-col items-center">
                <span class="text-sm font-semibold">{{ b.t }}</span>
                <span class="text-[10px] opacity-70">{{ b.hint }}</span>
              </span>
            </button>
          </div>
        </template>

        <!-- 拼读跟读 -->
        <template v-else-if="effMode === 'syllable'">
          <div class="card flex min-h-[320px] flex-1 flex-col justify-center gap-4 overflow-y-auto p-6">
            <div class="text-center">
              <p class="break-all text-[32px] font-semibold leading-tight text-slate-900">{{ cur.word.word }}</p>
              <p v-if="cur.word.phonetics.us || cur.word.phonetics.uk" class="phonetic mt-1 text-sm text-slate-500">
                {{ cur.word.phonetics.us || cur.word.phonetics.uk }}
              </p>
            </div>
            <div class="flex justify-center">
              <SyllableReader :word="cur.word" />
            </div>
            <div class="rounded-xl bg-slate-50 p-3">
              <template v-if="zhMeanings(cur.word).length">
                <p v-for="(m, mi) in zhMeanings(cur.word)" :key="mi" class="text-[15px] leading-relaxed text-slate-700">
                  <span v-if="m.pos && m.pos !== '—'"
                        class="mr-1 font-semibold text-brand-600">{{ m.pos }}</span>{{ m.zh.join('；') }}
                </p>
              </template>
              <p v-else class="text-center text-sm text-slate-400">暂无中文释义</p>
            </div>
          </div>
          <div class="mt-4 grid grid-cols-3 gap-2">
            <button v-for="b in GRADE_BTNS" :key="b.g" class="btn ring-1 py-3" :class="b.cls" @click="grade(b.g)">
              <span class="flex flex-col items-center">
                <span class="text-sm font-semibold">{{ b.t }}</span>
                <span class="text-[10px] opacity-70">{{ b.hint }}</span>
              </span>
            </button>
          </div>
        </template>

        <!-- 选择题 -->
        <template v-else-if="isChoice">
          <div class="card flex flex-col items-center justify-center gap-2 p-6">
            <p class="text-[11px] text-slate-400">
              {{ effMode === 'choice-en2zh' ? '选出正确的中文意思' : '选出对应的英文单词' }}
            </p>
            <template v-if="effMode === 'choice-en2zh'">
              <p class="text-[30px] font-semibold leading-tight text-slate-900">{{ cur.word.word }}</p>
              <button
                class="btn-soft mt-1 py-1.5"
                @click="pronounce(cur.word, { accent: settings.s.accent, rate: settings.s.speakRate })"
              >
                <svg class="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M3 10v4h4l5 4V6L7 10H3zm13.5 2a4.5 4.5 0 00-2.5-4v8a4.5 4.5 0 002.5-4z" />
                </svg>
                朗读
              </button>
            </template>
            <p v-else class="whitespace-pre-line text-center text-[18px] font-medium leading-snug text-slate-900">
              {{ chineseText(cur.word) }}
            </p>
          </div>

          <div class="mt-4 space-y-2.5">
            <button
              v-for="(opt, i) in cur.quiz.options"
              :key="i"
              class="w-full rounded-xl px-4 py-3.5 text-left text-[15px] ring-1 transition active:scale-[0.99]"
              :class="!answered
                ? 'bg-white text-slate-800 ring-slate-200'
                : opt === cur.quiz.correct
                  ? 'bg-emerald-50 text-emerald-700 ring-emerald-300'
                  : opt === picked
                    ? 'bg-rose-50 text-rose-600 ring-rose-300'
                    : 'bg-white text-slate-400 ring-slate-200'"
              @click="choose(opt)"
            >
              {{ opt }}
            </button>
          </div>

          <div v-if="answered && lastCorrect === false" class="mt-4">
            <div class="rounded-xl bg-white p-4 ring-1 ring-slate-200">
              <p class="text-sm font-medium text-slate-900">{{ cur.word.word }}</p>
              <p class="phonetic text-xs text-slate-500">{{ cur.word.phonetics.us || cur.word.phonetics.uk }}</p>
              <p class="mt-1 whitespace-pre-line text-[13px] leading-relaxed text-slate-600">{{ chineseText(cur.word) }}</p>
              <p class="mt-1.5 text-[11px] text-rose-500">已加入错题复习本</p>
            </div>
            <button class="btn-primary mt-3 w-full py-3" @click="next">继续</button>
          </div>
        </template>

        <!-- 拼写默写 -->
        <template v-else-if="effMode === 'spell'">
          <div class="card flex flex-col items-center justify-center gap-2 p-6">
            <p class="text-[11px] text-slate-400">根据中文写出英文</p>
            <p class="whitespace-pre-line text-center text-[18px] font-medium leading-snug text-slate-900">
              {{ chineseText(cur.word) }}
            </p>
            <p v-if="cur.word.phonetics.us || cur.word.phonetics.uk" class="phonetic mt-1 text-sm text-slate-500">
              {{ cur.word.phonetics.us || cur.word.phonetics.uk }}
            </p>
            <div class="mt-1 flex items-center gap-2">
              <button
                class="btn-soft py-1.5"
                @click="pronounce(cur.word, { accent: settings.s.accent, rate: settings.s.speakRate })"
              >
                <svg class="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M3 10v4h4l5 4V6L7 10H3zm13.5 2a4.5 4.5 0 00-2.5-4v8a4.5 4.5 0 002.5-4z" />
                </svg>
                听发音
              </button>
              <span class="text-[11px] text-slate-400">
                {{ cur.word.word.length }} 个字母，首字母 {{ cur.word.word[0] }}
              </span>
            </div>
          </div>

          <div class="mt-4">
            <input
              ref="inputRef"
              v-model="typed"
              class="input py-3.5 text-center text-lg tracking-wide"
              :class="answered ? (lastCorrect ? 'ring-2 ring-emerald-400' : 'ring-2 ring-rose-400') : ''"
              :disabled="answered"
              placeholder="在这里拼写"
              autocapitalize="off"
              autocorrect="off"
              spellcheck="false"
              enterkeyhint="done"
              @keyup.enter="answered ? next() : checkSpell()"
            />
            <button v-if="!answered" class="btn-primary mt-3 w-full py-3" :disabled="!typed.trim()" @click="checkSpell">
              检查
            </button>

            <div v-else class="mt-3">
              <div class="rounded-xl p-4 ring-1"
                   :class="lastCorrect ? 'bg-emerald-50 ring-emerald-200' : 'bg-rose-50 ring-rose-200'">
                <p class="text-sm" :class="lastCorrect ? 'text-emerald-700' : 'text-rose-600'">
                  {{ lastCorrect ? '拼对了' : `拼错了，正确拼写是` }}
                </p>
                <p class="mt-0.5 text-xl font-semibold tracking-wide text-slate-900">{{ cur.word.word }}</p>
                <p v-if="!lastCorrect" class="mt-1 text-[11px] text-rose-500">已加入错题复习本</p>
              </div>
              <button class="btn-primary mt-3 w-full py-3" @click="next">继续</button>
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
