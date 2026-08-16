/**
 * Free Dictionary API 适配器
 * 官网：https://dictionaryapi.dev/
 * 端点：https://api.dictionaryapi.dev/api/v2/entries/en/<word>
 *
 * ✅ 免费、无需 key、无官方调用限制、支持 CORS（可浏览器直连）
 * ✅ 提供：音标、英音/美音真人发音 mp3、词性、英文释义、例句
 * ❌ 不提供中文释义 —— 中文由 proxyTranslate.js 或导入时自带补齐
 *
 * 返回 404 表示词库里没有这个词（专有名词、拼写错误、生僻变形词常见）。
 */

const ENDPOINT = 'https://api.dictionaryapi.dev/api/v2/entries/en/'

/** 英文词性 -> 中文缩写 */
export const POS_MAP = {
  noun: 'n.',
  verb: 'v.',
  adjective: 'adj.',
  adverb: 'adv.',
  pronoun: 'pron.',
  preposition: 'prep.',
  conjunction: 'conj.',
  interjection: 'interj.',
  exclamation: 'interj.',
  numeral: 'num.',
  article: 'art.',
  determiner: 'det.',
  auxiliary: 'aux.',
  prefix: 'pref.',
  suffix: 'suf.',
  abbreviation: 'abbr.',
}

export function posLabel(pos) {
  if (!pos) return ''
  return POS_MAP[String(pos).toLowerCase()] || pos
}

/** 从 audio 链接里判断口音。
 *  Free Dictionary 的音频命名很乱，常见形态：
 *    .../hello-uk.mp3   .../en_US/hello_us_1.mp3   .../hello_gb_1.mp3
 *    .../hello-us.mp3   .../en_GB/hello.mp3        .../hello.mp3（无口音标记）
 *  旧逻辑只认 `-uk.`/`-us.` 这种连字符后缀，导致绝大多数没有后缀的通用音频
 *  （us_1.mp3 / gb_1.mp3 / 纯 hello.mp3）被丢弃，页面有音标却没真人音频，
 *  点发音退化成 TTS 读字母，听着「不对」。
 *  这里放宽匹配，并额外返回 isGeneric 标记（无口音后缀的音频两端可共用）。
 */
function accentInfo(url = '') {
  const u = url.toLowerCase()
  if (u.includes('-uk.') || u.includes('_uk.') || u.includes('-gb.') || u.includes('_gb.') || u.includes('/en_gb/') || u.includes('/british/')) {
    return { accent: 'uk', generic: false }
  }
  if (u.includes('-us.') || u.includes('_us.') || u.includes('/en_us/') || u.includes('/american/')) {
    return { accent: 'us', generic: false }
  }
  if (u.includes('-au.') || u.includes('_au.')) {
    return { accent: 'au', generic: false }
  }
  // 没有口音后缀的通用音频（如 hello.mp3 / hello_1.mp3）—— 两端兜底共用
  return { accent: '', generic: true }
}

function normalizePhonetic(text = '') {
  const t = String(text).trim()
  if (!t) return ''
  // 统一补上斜杠包裹
  return /^[/[]/.test(t) ? t : `/${t}/`
}

/**
 * 查询单词
 * @param {string} word
 * @param {{signal?:AbortSignal}} opts
 * @returns {Promise<{ok:boolean, notFound?:boolean, reason?:string, data?:object}>}
 */
const TIMEOUT_MS = 10000
const MAX_RETRY = 2 // 首次 + 重试 2 次

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 带超时的单次请求。
 * 原来没有超时，慢连接会一直挂着，批量导入时表现为「大面积查询失败」。
 */
async function fetchOnce(url, outerSignal) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
  const onAbort = () => ac.abort()
  outerSignal?.addEventListener('abort', onAbort)
  try {
    return { resp: await fetch(url, { signal: ac.signal }) }
  } catch (err) {
    const timedOut = err?.name === 'AbortError' && !outerSignal?.aborted
    return { err, timedOut }
  } finally {
    clearTimeout(timer)
    outerSignal?.removeEventListener('abort', onAbort)
  }
}

export async function lookup(word, { signal } = {}) {
  const w = String(word || '').trim()
  if (!w) return { ok: false, reason: 'empty' }

  const url = ENDPOINT + encodeURIComponent(w)
  let resp = null
  let lastErr = null

  // 网络抖动 / 429 限流 / 5xx 都值得重试，指数退避
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    if (signal?.aborted) return { ok: false, reason: 'aborted' }
    if (attempt > 0) await sleep(400 * 2 ** (attempt - 1))

    const r = await fetchOnce(url, signal)

    if (r.resp) {
      // 404 是「词典里没这个词」，不是错误，无需重试
      if (r.resp.status === 404) return { ok: false, notFound: true, reason: 'not-found' }
      if (r.resp.status === 429 || r.resp.status >= 500) {
        lastErr = { reason: 'http', message: `HTTP ${r.resp.status}` }
        continue
      }
      resp = r.resp
      break
    }

    if (signal?.aborted) return { ok: false, reason: 'aborted' }
    lastErr = {
      reason: r.timedOut ? 'timeout' : 'network',
      message: r.timedOut ? `请求超时（>${TIMEOUT_MS / 1000}s）` : r.err?.message || '网络请求失败',
    }
  }

  if (!resp) return { ok: false, ...(lastErr || { reason: 'network', message: '网络请求失败' }) }
  if (!resp.ok) return { ok: false, reason: 'http', message: `HTTP ${resp.status}` }

  let json
  try {
    json = await resp.json()
  } catch {
    return { ok: false, reason: 'parse' }
  }
  if (!Array.isArray(json) || json.length === 0) {
    return { ok: false, notFound: true, reason: 'not-found' }
  }

  /* ---------- 合并多个 entry（同一个词的不同词源会拆成多条） ---------- */
  const phonetics = { uk: '', us: '' }
  const audio = { uk: '', us: '' }
  const genericAudio = [] // 无口音后缀的通用音频，最后两端兜底共用
  let genericPhonetic = ''
  const posBucket = new Map()
  const examples = []

  for (const entry of json) {
    if (entry.phonetic && !genericPhonetic) genericPhonetic = normalizePhonetic(entry.phonetic)

    for (const p of entry.phonetics || []) {
      const info = accentInfo(p.audio || '')
      const text = normalizePhonetic(p.text || '')
      if (info.accent === 'uk' || info.accent === 'us') {
        if (text && !phonetics[info.accent]) phonetics[info.accent] = text
        if (p.audio && !audio[info.accent]) audio[info.accent] = p.audio
      } else if (info.generic) {
        // 没有口音标记的音频：音标照常用，音频先收着，最后两端兜底
        if (text && !genericPhonetic) genericPhonetic = text
        if (p.audio && genericAudio.length < 4 && !genericAudio.includes(p.audio)) {
          genericAudio.push(p.audio)
        }
      } else if (text && !genericPhonetic) {
        genericPhonetic = text
      }
    }

    for (const m of entry.meanings || []) {
      const pos = posLabel(m.partOfSpeech)
      if (!posBucket.has(pos)) posBucket.set(pos, { pos, zh: [], en: [] })
      const bucket = posBucket.get(pos)
      for (const d of m.definitions || []) {
        if (d.definition && bucket.en.length < 4 && !bucket.en.includes(d.definition)) {
          bucket.en.push(d.definition)
        }
        if (d.example && examples.length < 4) {
          examples.push({ en: d.example, pos })
        }
      }
    }
  }

  // 只有一种音标时，两个口音都用它，UI 不至于空着
  if (!phonetics.uk && !phonetics.us && genericPhonetic) {
    phonetics.uk = genericPhonetic
    phonetics.us = genericPhonetic
  } else {
    if (!phonetics.uk) phonetics.uk = phonetics.us || genericPhonetic
    if (!phonetics.us) phonetics.us = phonetics.uk || genericPhonetic
  }

  /* 真人音频兜底：Free Dictionary 大量音频没有口音后缀（us_1.mp3 / hello.mp3），
   * 上面没填进 uk/us，这里用通用音频补齐任一口音的空缺，保证点发音能播真人音。 */
  if (!audio.uk && !audio.us) {
    audio.uk = genericAudio[0] || ''
    audio.us = genericAudio[0] || ''
  } else {
    if (!audio.uk) audio.uk = audio.us || genericAudio[0] || ''
    if (!audio.us) audio.us = audio.uk || genericAudio[0] || ''
  }

  const meanings = [...posBucket.values()].filter((m) => m.en.length > 0)

  return {
    ok: true,
    data: {
      word: json[0].word || w,
      phonetics,
      audio,
      meanings,
      examples,
      source: 'freedict',
    },
  }
}
