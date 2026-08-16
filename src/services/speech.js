/**
 * 发音服务
 *
 * 两条路径：
 *   1. 词典返回的真人发音 mp3（音质好，Service Worker 会缓存，断网可播）
 *   2. 浏览器内置 TTS（speechSynthesis）—— 没有 mp3 时兜底，
 *      音节拼读也必须走 TTS，因为不存在「音节的 mp3」
 *
 * 已知平台坑（都已处理）：
 *   - iOS Safari 必须由用户手势触发首次发声，否则静默失败
 *   - Chrome 的 voices 列表是异步加载的，首次同步取会拿到空数组
 *   - 部分安卓机 utterance 结束不触发 onend，需要超时兜底
 */

import { syllabify } from './syllable.js'

let audioEl = null
let voicesCache = null
let unlocked = false

/* ------------------------------ mp3 播放 ------------------------------ */

function getAudioEl() {
  if (!audioEl) {
    audioEl = new Audio()
    audioEl.preload = 'auto'
  }
  return audioEl
}

export function playUrl(url, { rate = 1 } = {}) {
  return new Promise((resolve, reject) => {
    if (!url) return reject(new Error('没有音频地址'))
    const el = getAudioEl()
    el.pause()
    el.src = url
    el.playbackRate = rate
    const done = () => {
      el.removeEventListener('ended', done)
      el.removeEventListener('error', fail)
      resolve()
    }
    const fail = () => {
      el.removeEventListener('ended', done)
      el.removeEventListener('error', fail)
      reject(new Error('音频加载失败'))
    }
    el.addEventListener('ended', done)
    el.addEventListener('error', fail)
    el.play().catch(fail)
  })
}

/* ------------------------------ TTS ------------------------------ */

export function ttsSupported() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}

function loadVoices() {
  return new Promise((resolve) => {
    if (!ttsSupported()) return resolve([])
    const got = speechSynthesis.getVoices()
    if (got && got.length) {
      voicesCache = got
      return resolve(got)
    }
    // Chrome 首次是空的，等 voiceschanged
    let settled = false
    const handler = () => {
      if (settled) return
      settled = true
      voicesCache = speechSynthesis.getVoices()
      speechSynthesis.removeEventListener('voiceschanged', handler)
      resolve(voicesCache || [])
    }
    speechSynthesis.addEventListener('voiceschanged', handler)
    setTimeout(handler, 1200)
  })
}

export async function listEnglishVoices() {
  const all = voicesCache || (await loadVoices())
  return all.filter((v) => /^en(-|_)?/i.test(v.lang))
}

async function pickVoice(accent = 'us') {
  const en = await listEnglishVoices()
  if (!en.length) return null
  const want = accent === 'uk' ? /en[-_]GB/i : /en[-_]US/i
  return en.find((v) => want.test(v.lang)) || en[0]
}

/**
 * iOS 必须在用户手势里「解锁」一次语音合成，
 * 这里播一个空白 utterance 完成解锁。App 首次点击时调用。
 */
export function unlockTTS() {
  if (unlocked || !ttsSupported()) return
  try {
    const u = new SpeechSynthesisUtterance('')
    u.volume = 0
    speechSynthesis.speak(u)
    unlocked = true
  } catch {
    /* 忽略 */
  }
}

export function stopSpeaking() {
  if (ttsSupported()) speechSynthesis.cancel()
  if (audioEl) audioEl.pause()
}

/**
 * 用 TTS 读一段文本
 * @param {string} text
 * @param {{accent?:'uk'|'us', rate?:number, pitch?:number}} opts
 */
export function speak(text, { accent = 'us', rate = 1, pitch = 1 } = {}) {
  return new Promise(async (resolve) => {
    if (!ttsSupported() || !text) return resolve(false)

    speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(text)
    const voice = await pickVoice(accent)
    if (voice) u.voice = voice
    u.lang = accent === 'uk' ? 'en-GB' : 'en-US'
    u.rate = rate
    u.pitch = pitch

    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      resolve(true)
    }
    u.onend = finish
    u.onerror = finish

    // 部分安卓不触发 onend：按长度估算一个超时上限
    const estimate = Math.max(1200, (text.length / Math.max(rate, 0.4)) * 180)
    const timer = setTimeout(finish, estimate)

    speechSynthesis.speak(u)
  })
}

/* --------------------------- 组合播放策略 --------------------------- */

/**
 * 读整词：优先真人 mp3，失败或没有则 TTS
 * @param {object} word 词条对象
 */
export async function pronounce(word, { accent = 'us', rate = 1 } = {}) {
  const url = accent === 'uk' ? word?.audio?.uk : word?.audio?.us
  const fallbackUrl = word?.audio?.us || word?.audio?.uk
  const target = url || fallbackUrl
  if (target) {
    try {
      await playUrl(target, { rate })
      return 'audio'
    } catch {
      /* 落到 TTS */
    }
  }
  await speak(word?.word || '', { accent, rate })
  return 'tts'
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 拼读跟读：逐音节朗读 → 停顿 → 整词朗读，可循环
 *
 * @param {object|string} word 词条或纯字符串
 * @param {{accent?:string, rate?:number, loops?:number, gap?:number,
 *          onSyllable?:(index:number)=>void, shouldStop?:()=>boolean}} opts
 */
export async function spellOut(word, opts = {}) {
  const {
    accent = 'us',
    rate = 0.75,
    loops = 1,
    gap = 320,
    onSyllable = null,
    onWhole = null,
    shouldStop = () => false,
  } = opts

  const text = typeof word === 'string' ? word : word?.word || ''
  if (!text) return
  const parts =
    (typeof word === 'object' && Array.isArray(word?.syllables) && word.syllables.length
      ? word.syllables
      : syllabify(text)) || [text]

  for (let loop = 0; loop < loops; loop++) {
    for (let i = 0; i < parts.length; i++) {
      if (shouldStop()) return
      onSyllable?.(i)
      // 单音节直接送 TTS 有时会被读成字母名，补个轻微延长更接近拼读
      await speak(parts[i], { accent, rate })
      await sleep(gap)
    }
    if (shouldStop()) return
    onSyllable?.(-1)
    onWhole?.()
    // 整词用真人音频（如果有），拼完再听一遍标准读音
    if (typeof word === 'object') {
      await pronounce(word, { accent, rate: 1 })
    } else {
      await speak(text, { accent, rate: 0.95 })
    }
    await sleep(gap * 2)
  }
  onSyllable?.(null)
}
