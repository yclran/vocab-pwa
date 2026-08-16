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

/** 从 audio 链接里判断口音：.../hello-uk.mp3 */
function accentOf(url = '') {
  const u = url.toLowerCase()
  if (u.includes('-uk.') || u.includes('-gb.')) return 'uk'
  if (u.includes('-us.')) return 'us'
  if (u.includes('-au.')) return 'au'
  return ''
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
  let genericPhonetic = ''
  const posBucket = new Map()
  const examples = []

  for (const entry of json) {
    if (entry.phonetic && !genericPhonetic) genericPhonetic = normalizePhonetic(entry.phonetic)

    for (const p of entry.phonetics || []) {
      const acc = accentOf(p.audio || '')
      const text = normalizePhonetic(p.text || '')
      if (acc === 'uk' || acc === 'us') {
        if (text && !phonetics[acc]) phonetics[acc] = text
        if (p.audio && !audio[acc]) audio[acc] = p.audio
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
