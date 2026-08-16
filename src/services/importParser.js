/**
 * 导入解析器
 *
 * 需要同时吃下四种输入，且不需要用户手工调整格式：
 *   格式 A  逐行纯英文          ability
 *   格式 B  逐行英文+中文       able 能够的  /  able  adj. 能够的  /  able：能够的
 *   格式 C  大段英文文章        从散文里抽出独立单词
 *   格式 D  .txt / .docx 文件   读成纯文本后走 A/B/C
 *
 * 判定逻辑：先按行拆；如果「像词表」的行占多数就走逐行模式，
 * 否则认为是文章，走分词提取模式。
 */

/** 行首序号：1. / 1、/ 1) / ① / - / * */
const LEADING_NUM = /^\s*(?:[（(]?\d+[）)、.]|\d+\s|[-*•·]|[①-⑳])\s*/

/** 英文单词或短语（允许连字符、撇号、最多 4 个词的短语） */
const WORD_RE = /^[a-zA-Z][a-zA-Z'’\-]*(?:\s+[a-zA-Z'’\-]+){0,3}$/

/** 中文字符 */
const HAS_CJK = /[\u4e00-\u9fff]/

/** 词性标记，中英混排时要从中文里剥掉 */
const POS_PREFIX = /^(?:n|v|vt|vi|adj|adv|prep|pron|conj|art|num|int|interj|aux|abbr|pl|u|c)\s*\.\s*/i

/** 高频虚词，从文章提词时默认过滤（可关） */
export const STOPWORDS = new Set(
  `a an the and or but if of to in on at by for with from as is are was were be been being am do does did done
   have has had having i you he she it we they me him her us them my your his its our their this that these those
   not no nor so than then there here when where which who whom whose what why how all any both each few more most
   other some such only own same too very can will just should now shall would could may might must up down out off
   over under again further once about into through during before after above below between out against s t don`
    .split(/\s+/)
    .filter(Boolean)
)

function stripLeading(line) {
  return line.replace(LEADING_NUM, '').trim()
}

function cleanZh(zh) {
  let s = String(zh).trim()
  // 去掉包裹的括号和多余分隔符
  s = s.replace(/^[：:\-–—=、,，.。\s]+/, '').replace(/[；;，,、\s]+$/, '')
  return s.trim()
}

/**
 * 拆一行「英文 + 中文」
 * @returns {{word:string, zh:string|null}|null}
 */
export function parseLine(rawLine) {
  const line = stripLeading(String(rawLine || ''))
  if (!line) return null

  // 情况 1：显式分隔符（tab / 多空格 / 冒号 / 逗号 / 竖线 / 破折号）
  const sepMatch = line.match(/^([^\t|：:]+?)(?:\t+|\s{2,}|\s*[|：:]\s*|\s+[-–—]\s+)(.+)$/)
  if (sepMatch) {
    const left = sepMatch[1].trim()
    const right = cleanZh(sepMatch[2])
    if (WORD_RE.test(left)) {
      return { word: left, zh: HAS_CJK.test(right) ? right.replace(POS_PREFIX, '').trim() : null }
    }
  }

  // 情况 2：英文在前、中文在后，中间只有一个空格（able 能够的）
  const cjkIdx = line.search(HAS_CJK)
  if (cjkIdx > 0) {
    const left = line.slice(0, cjkIdx).trim()
    const right = cleanZh(line.slice(cjkIdx))
    // 左边可能残留词性："able adj." -> 剥掉
    const leftClean = left.replace(/\s*\b(?:n|v|vt|vi|adj|adv|prep|pron|conj|art|num|int|interj|aux|abbr)\s*\.\s*$/i, '').trim()
    if (WORD_RE.test(leftClean)) {
      return { word: leftClean, zh: right || null }
    }
    return null
  }

  // 情况 3：整行纯英文
  if (WORD_RE.test(line)) return { word: line, zh: null }

  // 情况 4：一行里逗号分隔的多个英文词（交给上层拆）
  return null
}

/**
 * 逐行解析（格式 A / B）
 */
export function parseLines(text) {
  const entries = []
  const skipped = []
  const seen = new Set()

  const push = (word, zh) => {
    const k = word.toLowerCase()
    if (seen.has(k)) return
    seen.add(k)
    entries.push({ word, zh: zh || null })
  }

  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = stripLeading(raw)
    if (!line) continue

    // 先看这一行是不是「逗号/分号/顿号分隔的一串词」。
    // 必须放在 parseLine 之前：像 "come, get, give" 这种，
    // parseLine 的情况 3 会整行判定失败，但更糟的是
    // "able 能够的, about 关于" 会被情况 2 错切成一个词。
    const bySep = splitBySeparator(line)
    if (bySep) {
      for (const it of bySep) push(it.word, it.zh)
      continue
    }

    const one = parseLine(line)
    if (one) {
      push(one.word, one.zh)
      continue
    }

    skipped.push(line)
  }

  return { entries, skipped }
}

/**
 * 拆「一行里多个词」：come, get, give / able 能够的; about 关于
 *
 * 判定放宽到「多数片段像词条」即可，不再要求全部命中 —— 
 * 现实里总有一两个片段带着奇怪的标点。
 *
 * @returns {Array<{word:string,zh:string|null}>|null} 不像词表就返回 null
 */
export function splitBySeparator(line) {
  const s = String(line || '').trim()
  if (!s) return null
  // 中文释义里大量使用「，；、」，所以只用半角逗号/分号和顿号做切分，
  // 且要求切出来的片段本身像词条，避免把一句中文切碎
  if (!/[,;]/.test(s)) return null

  const parts = s
    .split(/[,;]+/)
    .map((p) => stripLeading(p).replace(/[.。]+$/, '').trim())
    .filter(Boolean)

  if (parts.length < 2) return null

  const parsed = parts.map((p) => parseLine(p))
  const hit = parsed.filter(Boolean).length

  // 至少 2 个、且 70% 以上的片段能解析成词条，才认定这是一行词表
  if (hit < 2 || hit / parts.length < 0.7) return null

  return parsed.filter(Boolean)
}

/**
 * 从大段文本里提词（格式 C）
 * @param {string} text
 * @param {{minLen?:number, filterStopwords?:boolean, keepCase?:boolean}} opts
 */
export function extractWords(text, { minLen = 3, filterStopwords = true } = {}) {
  const tokens = String(text || '').match(/[a-zA-Z][a-zA-Z'’\-]*/g) || []
  const seen = new Set()
  const entries = []
  // 被丢掉的词要能报给用户看，否则「明明粘了 26 个只出来 10 个」根本无从排查
  const dropped = { short: [], stopword: [] }

  for (const t of tokens) {
    const clean = t.replace(/^['’\-]+|['’\-]+$/g, '')
    const lower = clean.toLowerCase()
    if (!lower || seen.has(lower)) continue

    if (clean.length < minLen) {
      seen.add(lower)
      dropped.short.push(lower)
      continue
    }
    if (filterStopwords && STOPWORDS.has(lower)) {
      seen.add(lower)
      dropped.stopword.push(lower)
      continue
    }

    seen.add(lower)
    // 全大写的缩写保留原样，其余统一小写
    entries.push({ word: /^[A-Z]{2,}$/.test(clean) ? clean : lower, zh: null })
  }
  return { entries, skipped: [], dropped }
}

/**
 * 自动判断该用哪种模式
 * @returns {'lines'|'prose'}
 */
export function detectMode(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => stripLeading(l))
    .filter(Boolean)

  if (lines.length === 0) return 'prose'

  // 先判词表：一行一个词、或者一行里逗号分隔一串词，都算词表。
  // 这一步必须在「长行=文章」之前，否则
  //   come, get, give, ... （26 个词挤在一行）
  // 会被当成文章去提词，然后被停用词表和最短长度砍掉一大半。
  const wordLike = lines.filter((l) => parseLine(l) !== null || splitBySeparator(l) !== null).length
  if (wordLike / lines.length >= 0.6) return 'lines'

  // 单行超长（>12 个词）基本就是文章
  const longLines = lines.filter((l) => l.split(/\s+/).length > 12).length
  if (longLines / lines.length > 0.3) return 'prose'

  return 'prose'
}

/**
 * 统一入口：自动识别格式并解析
 * @param {string} text
 * @param {{mode?:'auto'|'lines'|'prose', filterStopwords?:boolean, minLen?:number}} opts
 */
export function parseText(text, { mode = 'auto', filterStopwords = true, minLen = 3 } = {}) {
  const realMode = mode === 'auto' ? detectMode(text) : mode
  const result =
    realMode === 'lines' ? parseLines(text) : extractWords(text, { filterStopwords, minLen })

  const withZh = result.entries.filter((e) => e.zh).length
  const dropped = result.dropped || { short: [], stopword: [] }
  return {
    mode: realMode,
    entries: result.entries,
    skipped: result.skipped,
    dropped,
    stats: {
      total: result.entries.length,
      withZh,
      withoutZh: result.entries.length - withZh,
      skipped: result.skipped.length,
      droppedShort: dropped.short.length,
      droppedStopword: dropped.stopword.length,
    },
  }
}

/* ------------------------------ 文件读取 ------------------------------ */

function readAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('文件读取失败'))
    // 大部分词表是 UTF-8；GBK 的中文会乱码，UI 上会提示
    reader.readAsText(file, 'UTF-8')
  })
}

/**
 * 读取 .txt / .docx / .md / .csv
 * docx 用 mammoth 动态导入，不进首屏包
 */
export async function readFile(file) {
  const name = (file?.name || '').toLowerCase()

  if (name.endsWith('.docx')) {
    const mammoth = await import('mammoth')
    const buf = await file.arrayBuffer()
    const { value } = await mammoth.extractRawText({ arrayBuffer: buf })
    return value
  }

  if (name.endsWith('.doc')) {
    throw new Error('不支持旧版 .doc 格式，请用 Word 另存为 .docx 后再导入')
  }

  return readAsText(file)
}
