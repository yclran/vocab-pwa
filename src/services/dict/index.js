/**
 * 词典编排层
 *
 * 职责：把多个 provider 的结果合并成统一词条，写回 IndexedDB 永久缓存。
 * 一旦查过，断网也能背 —— 这是「离线可用」的实现方式。
 *
 * provider 优先级：
 *   音标 / 发音 / 词性 / 英文释义  -> Free Dictionary（免费直连）
 *   中文释义                      -> 导入自带 > 翻译代理 > 空
 *   音节拆分                      -> 本地算法，不依赖网络
 *
 * 想接入 ECDICT / 有道词典 / 自建词库时，
 * 只要新增一个 provider 文件并在 mergeInto 里加一段即可，其它代码不用动。
 */

import { lookup as freeLookup } from './freeDictionary.js'
import { translateBatch, checkStatus } from './proxyTranslate.js'
import { syllabify } from '../syllable.js'
import { getWord, putWord } from '../../db/repo.js'

export { checkStatus }

/** 并发控制：Free Dictionary 是公益服务，别把人家打挂 */
const CONCURRENCY = 3

function isOnline() {
  return typeof navigator === 'undefined' || navigator.onLine !== false
}

/**
 * 把 provider 结果合并进词条对象（原地修改）
 *
 * @param {object} word  词条
 * @param {object|null} free  Free Dictionary 结果：音标 / 音频 / 词性 / 英文释义
 * @param {object|null} zh    中文 provider 结果：分词性中文释义 / 音标 / 考纲标签
 */
function mergeInto(word, free, zh) {
  /* ---------- 先按词性建桶，两个 provider 往同一个桶里塞 ---------- */
  const bucket = new Map()
  const touch = (pos) => {
    const k = pos || '—'
    if (!bucket.has(k)) bucket.set(k, { pos: k, zh: [], en: [] })
    return bucket.get(k)
  }

  // 保留此前已有的中文（可能来自导入自带或上一次补全）
  for (const m of word.meanings || []) {
    const b = touch(m.pos)
    for (const t of m.zh || []) if (!b.zh.includes(t)) b.zh.push(t)
  }

  if (free) {
    for (const m of free.meanings || []) {
      const b = touch(m.pos)
      for (const e of m.en || []) if (!b.en.includes(e)) b.en.push(e)
    }
  }

  if (zh) {
    for (const m of zh.meanings || []) {
      const b = touch(m.pos)
      if (m.zh && !b.zh.includes(m.zh)) b.zh.push(m.zh)
    }
  }

  const merged = [...bucket.values()].filter((m) => m.zh.length || m.en.length)
  if (merged.length) word.meanings = merged

  /* ---------- 音标：Free Dictionary 优先，缺失时用中文源补 ---------- */
  word.phonetics = {
    uk: free?.phonetics?.uk || word.phonetics?.uk || zh?.phonetics?.uk || '',
    us: free?.phonetics?.us || word.phonetics?.us || zh?.phonetics?.us || '',
  }

  if (free) {
    word.audio = {
      uk: free.audio?.uk || word.audio?.uk || '',
      us: free.audio?.us || word.audio?.us || '',
    }
    word.examples = free.examples || word.examples || []
    if (!word.dictSources.includes('freedict')) word.dictSources.push('freedict')
  }

  if (zh) {
    // 考纲标签：初中 / 高中 / CET4 …… 可用来筛选孩子要背的词
    if (zh.exam?.length) word.exam = zh.exam
    if (zh.forms?.length) word.forms = zh.forms
    const src = zh.source || 'translate'
    if (!word.dictSources.includes(src)) word.dictSources.push(src)
  }

  // 音节拆分本地算，任何时候都能有
  if (!word.syllables || !word.syllables.length) {
    word.syllables = syllabify(word.word)
  }
  return word
}

/**
 * 把代理返回的一条数据规整成 mergeInto 能吃的格式。
 * 兼容两种 provider 形态：
 *   - youdao-dict：{ meanings:[{pos,zh}], phonetics, exam, forms }
 *   - 纯翻译 API ：{ zh:['放弃'] }  —— 没有词性，塞进无词性桶
 */
function normalizeZhPayload(payload) {
  if (!payload) return null
  if (payload.meanings?.length) return payload
  if (payload.zh?.length) {
    return { ...payload, meanings: payload.zh.map((t) => ({ pos: '', zh: t })) }
  }
  return null
}

/** 当前词条是否已经有中文 */
export function hasChinese(word) {
  if (word?.zhRaw) return true
  if (word?.zhAuto) return true
  return (word?.meanings || []).some((m) => (m.zh || []).length > 0)
}

/** 取展示用的中文文本 */
export function chineseText(word) {
  if (word?.zhRaw) return word.zhRaw
  const fromMeanings = (word?.meanings || [])
    .filter((m) => (m.zh || []).length)
    .map((m) => {
      const pos = m.pos && m.pos !== '—' ? `${m.pos} ` : ''
      return pos + m.zh.join('；')
    })
    .join('\n')
  if (fromMeanings) return fromMeanings
  return word?.zhAuto || ''
}

/** 选择题干扰项要短，取第一条中文即可 */
export function chineseShort(word, max = 24) {
  const full = chineseText(word).split('\n')[0] || ''
  const first = full.split(/[；;]/)[0].trim()
  const t = first || full
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/** 取展示用的英文释义（中文缺失时的替补） */
export function englishText(word, max = 2) {
  return (word?.meanings || [])
    .flatMap((m) => m.en.slice(0, 1).map((e) => `${m.pos} ${e}`))
    .slice(0, max)
    .join('\n')
}

/**
 * 查询单个词并写回数据库
 * @param {string} key
 * @param {{force?:boolean, withTranslate?:boolean}} opts
 */
export async function enrichOne(key, { force = false, withTranslate = true } = {}) {
  const word = await getWord(key)
  if (!word) return { ok: false, reason: 'no-word' }
  if (!force && word.dictStatus === 'ok' && hasChinese(word)) {
    return { ok: true, cached: true, word }
  }

  if (!isOnline()) {
    return { ok: false, reason: 'offline', word }
  }

  const needZh = withTranslate && (force || !hasChinese(word))

  // 英文侧和中文侧并行，慢的那个决定总耗时，不再串行等两遍
  const [res, zhRes] = await Promise.all([
    freeLookup(word.word),
    needZh ? translateBatch([word.word]) : Promise.resolve(null),
  ])

  const zhData = normalizeZhPayload(zhRes?.data?.[word.word])
  mergeInto(word, res.ok ? res.data : null, zhData)

  if (res.ok) {
    word.dictStatus = 'ok'
    word.dictError = null
  } else if (zhData) {
    // 英文源挂了但中文查到了，照样能背
    word.dictStatus = 'partial'
    word.dictError = res.notFound ? '英文词典未收录，中文释义来自有道' : res.message || null
  } else if (res.notFound) {
    word.dictStatus = word.zhRaw ? 'partial' : 'failed'
    word.dictError = '词典中没有收录这个词'
  } else {
    word.dictStatus = word.zhRaw ? 'partial' : 'failed'
    word.dictError = res.message || '查询失败'
  }

  await putWord(word)
  return { ok: word.dictStatus === 'ok' || word.dictStatus === 'partial', word }
}

/**
 * 批量补全。导入大批单词后调用，带进度回调。
 *
 * @param {string[]} keys
 * @param {{
 *   force?:boolean,
 *   onProgress?:(done:number, total:number, current:string)=>void,
 *   shouldStop?:()=>boolean
 * }} opts
 */
export async function enrichMany(keys, { force = false, onProgress, shouldStop } = {}) {
  const total = keys.length
  let done = 0
  const stats = { ok: 0, notFound: 0, failed: 0, skipped: 0 }
  const needTranslate = []

  if (!isOnline()) {
    return { ...stats, skipped: total, offline: true }
  }

  /* ---------- 第一阶段：Free Dictionary，并发 4 ---------- */
  const queue = [...keys]
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      if (shouldStop?.()) return
      const key = queue.shift()
      const word = await getWord(key)
      if (!word) {
        done++
        continue
      }
      if (!force && word.dictStatus === 'ok') {
        stats.skipped++
        done++
        onProgress?.(done, total, word.word)
        if (!hasChinese(word)) needTranslate.push(word.key)
        continue
      }

      const res = await freeLookup(word.word)
      if (res.ok) {
        mergeInto(word, res.data)
        word.dictStatus = 'ok'
        stats.ok++
      } else if (res.notFound) {
        mergeInto(word, null)
        word.dictStatus = word.zhRaw ? 'partial' : 'failed'
        word.dictError = '词典中没有收录这个词'
        stats.notFound++
      } else {
        mergeInto(word, null)
        word.dictStatus = 'failed'
        word.dictError = res.message || '查询失败'
        stats.failed++
      }
      await putWord(word)

      if (!hasChinese(word)) needTranslate.push(word.key)

      done++
      onProgress?.(done, total, word.word)
    }
  })
  await Promise.all(workers)

  /* ---------- 第二阶段：中文批量补全，每批 20 个 ---------- *
   * 默认走 youdao-dict（免密钥），返回分词性中文释义 + 音标 + 考纲标签。
   * 纯静态托管没有 /api/dict 时，translateBatch 会失败，这里如实计数并提示。
   */
  if (needTranslate.length) {
    const BATCH = 20
    let zhDone = 0
    let proxyDown = false

    for (let i = 0; i < needTranslate.length; i += BATCH) {
      if (shouldStop?.()) break

      const chunk = needTranslate.slice(i, i + BATCH)
      const words = []
      const map = new Map()
      for (const k of chunk) {
        const w = await getWord(k)
        if (w) {
          words.push(w.word)
          map.set(w.word, w)
        }
      }
      if (!words.length) continue

      const t = await translateBatch(words)
      if (!t.ok) {
        // 代理不可用就没必要继续打后面的批次了
        proxyDown = true
        stats.translateError = t.message || '中文释义补全失败'
        break
      }

      for (const [text, val] of Object.entries(t.data || {})) {
        const w = map.get(text)
        const zhData = normalizeZhPayload(val)
        if (!w || !zhData) continue
        mergeInto(w, null, zhData)
        if (w.dictStatus === 'failed') w.dictStatus = 'partial'
        await putWord(w)
        zhDone++
      }

      onProgress?.(done, total, `补中文释义 ${Math.min(i + BATCH, needTranslate.length)}/${needTranslate.length}`)
    }

    stats.zhFilled = zhDone
    if (proxyDown || zhDone === 0) {
      stats.noTranslateProvider = needTranslate.length - zhDone
    }
  }

  return stats
}

/** 手动补一个词的中文（词典查不到时用户自己填） */
export async function setManualChinese(key, zh) {
  const word = await getWord(key)
  if (!word) return null
  word.zhRaw = String(zh || '').trim() || null
  if (word.zhRaw && word.dictStatus === 'failed') word.dictStatus = 'partial'
  if (!word.dictSources.includes('manual')) word.dictSources.push('manual')
  await putWord(word)
  return word
}
