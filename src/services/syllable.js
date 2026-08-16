/**
 * 英文单词音节拆分（拼读功能的核心）
 *
 * 说明：这是**启发式**算法，不是词典级精确切分。
 * 英语音节切分本身没有唯一标准答案（不同词典切法也不一致），
 * 这里的目标是给孩子一个可以「分段跟读」的合理切法，能读顺就够用。
 * 常见不规则词放在 EXCEPTIONS 里硬编码兜底。
 *
 * 算法流程：
 *   1. 找出元音组（连续元音算一个音节核，特定二合元音强制断开）
 *   2. 处理不发音的词尾 e / ed / es
 *   3. 在相邻两个音节核之间按辅音数量决定断点：
 *      0 个 -> 直接断    1 个 -> V-CV（辅音跟后面）
 *      多个 -> 从后往前找最长的合法首辅音簇，其余留给前一音节
 */

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u', 'y'])

/** 合法的英文词首辅音簇：决定多辅音时断在哪 */
const VALID_ONSETS = new Set([
  'bl', 'br', 'ch', 'cl', 'cr', 'dr', 'dw', 'fl', 'fr', 'gl', 'gn', 'gr',
  'kn', 'ph', 'pl', 'pr', 'ps', 'qu', 'sc', 'sh', 'sk', 'sl', 'sm', 'sn',
  'sp', 'st', 'sw', 'th', 'tr', 'tw', 'wh', 'wr',
  'sch', 'scr', 'shr', 'sph', 'spl', 'spr', 'squ', 'str', 'thr',
])

/** 需要强制断开的元音组合（避免把两个音节核并成一个） */
const HIATUS = new Set(['ia', 'io', 'iu', 'eo', 'ua', 'uo', 'ii', 'oi' /* ×不断 */])
HIATUS.delete('oi') // oi 是二合元音（coin），不能断

/** 高频不规则词，直接查表 */
const EXCEPTIONS = {
  people: ['peo', 'ple'],
  because: ['be', 'cause'],
  business: ['busi', 'ness'],
  every: ['ev', 'ery'],
  family: ['fam', 'i', 'ly'],
  interest: ['in', 'ter', 'est'],
  vegetable: ['veg', 'e', 'ta', 'ble'],
  restaurant: ['res', 'tau', 'rant'],
  comfortable: ['com', 'fort', 'a', 'ble'],
  different: ['dif', 'fer', 'ent'],
  favourite: ['fa', 'vou', 'rite'],
  favorite: ['fa', 'vo', 'rite'],
  question: ['ques', 'tion'],
  nation: ['na', 'tion'],
  station: ['sta', 'tion'],
  education: ['ed', 'u', 'ca', 'tion'],
  information: ['in', 'for', 'ma', 'tion'],
  elephant: ['el', 'e', 'phant'],
  chicken: ['chick', 'en'],
  animal: ['an', 'i', 'mal'],
  another: ['an', 'oth', 'er'],
  together: ['to', 'geth', 'er'],
  english: ['eng', 'lish'],
  again: ['a', 'gain'],
  said: ['said'],
  friend: ['friend'],
  science: ['sci', 'ence'],
  medicine: ['med', 'i', 'cine'],
  library: ['li', 'brar', 'y'],
  usually: ['u', 'su', 'al', 'ly'],
  beautiful: ['beau', 'ti', 'ful'],
  dangerous: ['dan', 'ger', 'ous'],
  delicious: ['de', 'li', 'cious'],
  weather: ['weath', 'er'],
  mother: ['moth', 'er'],
  father: ['fa', 'ther'],
  brother: ['broth', 'er'],
  water: ['wa', 'ter'],
  little: ['lit', 'tle'],
}

function isVowel(ch) {
  return VOWELS.has(ch)
}

/** 把辅音串切成「单位」：把 ph/ch/sh/th/wh/qu 这类二合字母视为一个不可分单位 */
function tokenizeCluster(cluster) {
  const DIGRAPHS = ['ph', 'ch', 'sh', 'th', 'wh', 'qu', 'gh']
  const units = []
  let i = 0
  while (i < cluster.length) {
    const two = cluster.slice(i, i + 2)
    if (two.length === 2 && DIGRAPHS.includes(two)) {
      units.push(two)
      i += 2
    } else {
      units.push(cluster[i])
      i += 1
    }
  }
  return units
}

function splitPart(word) {
  const w = word.toLowerCase()
  if (w.length <= 3) return [word]

  const chars = w.split('')
  const n = chars.length

  /* --- 1. 找音节核 --- */
  let nuclei = []
  let i = 0
  while (i < n) {
    if (isVowel(chars[i])) {
      let j = i
      while (j + 1 < n && isVowel(chars[j + 1])) j++
      // 元音组内部的强制断点
      let start = i
      for (let k = i; k < j; k++) {
        if (HIATUS.has(chars[k] + chars[k + 1])) {
          nuclei.push([start, k])
          start = k + 1
        }
      }
      nuclei.push([start, j])
      i = j + 1
    } else {
      i++
    }
  }

  if (nuclei.length <= 1) return [word]

  /* --- 2. 不发音的词尾 --- */
  const last = nuclei[nuclei.length - 1]
  const tail = w.slice(last[0])

  const dropSilent = () => {
    nuclei = nuclei.slice(0, -1)
  }

  if (tail === 'e' && last[0] === n - 1) {
    // 结尾 -Cle（table / apple / little）保留，其余静音 e 丢掉
    const isConsonantLe = n >= 3 && chars[n - 2] === 'l' && !isVowel(chars[n - 3])
    if (!isConsonantLe) dropSilent()
  } else if (tail === 'es' && last[0] === n - 2) {
    // walks/makes 的 e 不发音；boxes/watches/buses 的发音
    const prev = w.slice(0, n - 2)
    const sibilant = /(s|z|x|ch|sh|ge|ce)$/.test(prev)
    if (!sibilant) dropSilent()
  } else if (tail === 'ed' && last[0] === n - 2) {
    // walked 不发音；wanted/needed 发音
    const before = chars[n - 3]
    if (before !== 't' && before !== 'd') dropSilent()
  }

  if (nuclei.length <= 1) return [word]

  /* --- 3. 计算断点 --- */
  const breaks = []
  for (let k = 0; k < nuclei.length - 1; k++) {
    const endA = nuclei[k][1]
    const startB = nuclei[k + 1][0]
    const cluster = w.slice(endA + 1, startB)

    if (cluster.length === 0) {
      breaks.push(endA + 1)
      continue
    }

    const units = tokenizeCluster(cluster)
    if (units.length === 1) {
      // 单个辅音（含二合字母）跟到后一个音节：ba-by / wa-ter / e-le-phant
      breaks.push(endA + 1)
      continue
    }

    // 多个辅音单位：从后往前找最长的合法首辅音簇，至少留一个给前一音节
    let taken = 1
    for (let t = Math.min(3, units.length - 1); t >= 1; t--) {
      const onset = units.slice(units.length - t).join('')
      if (onset.length === 1 || VALID_ONSETS.has(onset)) {
        taken = t
        break
      }
    }
    const keepLen = units.slice(0, units.length - taken).join('').length
    breaks.push(endA + 1 + keepLen)
  }

  /* --- 4. 按断点切原始大小写的字符串 --- */
  const out = []
  let prev = 0
  for (const b of breaks) {
    if (b > prev && b < word.length) {
      out.push(word.slice(prev, b))
      prev = b
    }
  }
  out.push(word.slice(prev))
  return out.filter(Boolean)
}

/**
 * 拆分单词为音节数组
 * @param {string} word
 * @returns {string[]} 例如 computer -> ['com','pu','ter']
 */
export function syllabify(word) {
  const raw = String(word || '').trim()
  if (!raw) return []

  const hit = EXCEPTIONS[raw.toLowerCase()]
  if (hit) return hit

  // 词组 / 连字符词：先按空格和连字符切，再各自处理
  const segments = raw.split(/([\s-]+)/)
  const out = []
  for (const seg of segments) {
    if (!seg) continue
    if (/^[\s-]+$/.test(seg)) {
      if (out.length) out[out.length - 1] += seg
      continue
    }
    out.push(...splitPart(seg))
  }
  return out.length ? out : [raw]
}

/** 音节数量 */
export function syllableCount(word) {
  return syllabify(word).length
}

/** 展示用：com·pu·ter */
export function syllableText(word, sep = '·') {
  return syllabify(word).join(sep)
}
