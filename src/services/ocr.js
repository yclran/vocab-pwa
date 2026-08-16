/**
 * 拍照 OCR
 *
 * 默认引擎：Tesseract.js（纯浏览器本地运行，免费、无 key、无服务器、可离线）
 *
 * ⚠️ 必须说清楚的能力边界：
 *   - 印刷体英文：清晰、正对、光线均匀时识别率可用（配合下面的预处理会好很多）
 *   - 手写英文：Tesseract 官方 eng 模型是为印刷体训练的，
 *     识别手写体错误率很高，经常错到没法改。这不是参数能调好的，是模型本身的限制。
 *     所以手写模式下必须走「识别 → 人工逐条修正」的流程，UI 里默认展开编辑框。
 *     如果对手写有硬需求，需要接百度手写 OCR（要服务端代理 + 实名认证的 AK/SK）。
 *
 * 提升识别率的关键在预处理，而不是引擎参数：
 *   放大到合适尺寸 -> 灰度 -> Otsu 自适应二值化 -> 送入引擎
 */

let workerPromise = null
let currentLang = null

/* --------------------------- 图像处理 --------------------------- */

/** File / Blob -> HTMLImageElement */
export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片加载失败'))
    img.src = typeof src === 'string' ? src : URL.createObjectURL(src)
  })
}

/**
 * 裁剪 + 缩放 + 二值化
 * @param {HTMLImageElement} img
 * @param {{x:number,y:number,w:number,h:number}|null} rect 归一化坐标(0~1)，null 表示整图
 * @param {{binarize?:boolean, targetWidth?:number}} opts
 * @returns {HTMLCanvasElement}
 */
export function preprocess(img, rect = null, { binarize = true, targetWidth = 1400 } = {}) {
  const sx = rect ? Math.round(rect.x * img.naturalWidth) : 0
  const sy = rect ? Math.round(rect.y * img.naturalHeight) : 0
  const sw = rect ? Math.round(rect.w * img.naturalWidth) : img.naturalWidth
  const sh = rect ? Math.round(rect.h * img.naturalHeight) : img.naturalHeight

  // 太小的图放大，太大的图缩小 —— OCR 对字高有最佳区间
  let scale = targetWidth / sw
  scale = Math.min(Math.max(scale, 1), 3)
  const dw = Math.round(sw * scale)
  const dh = Math.round(sh * scale)

  const canvas = document.createElement('canvas')
  canvas.width = dw
  canvas.height = dh
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh)

  if (!binarize) return canvas

  const imageData = ctx.getImageData(0, 0, dw, dh)
  const d = imageData.data

  // 1) 灰度 + 直方图
  const hist = new Array(256).fill(0)
  const gray = new Uint8ClampedArray(dw * dh)
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0
    gray[p] = g
    hist[g]++
  }

  // 2) Otsu 求全局阈值
  const total = dw * dh
  let sum = 0
  for (let t = 0; t < 256; t++) sum += t * hist[t]
  let sumB = 0
  let wB = 0
  let maxVar = -1
  let threshold = 128
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (wB === 0) continue
    const wF = total - wB
    if (wF === 0) break
    sumB += t * hist[t]
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > maxVar) {
      maxVar = between
      threshold = t
    }
  }

  // 3) 二值化，稍微偏白一点，避免笔画粘连
  const bias = 8
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const v = gray[p] > threshold - bias ? 255 : 0
    d[i] = d[i + 1] = d[i + 2] = v
    d[i + 3] = 255
  }
  ctx.putImageData(imageData, 0, 0)
  return canvas
}

/* --------------------------- 引擎 --------------------------- */

async function getWorker(lang, onProgress) {
  if (workerPromise && currentLang === lang) return workerPromise
  if (workerPromise) {
    const old = await workerPromise
    await old.terminate().catch(() => {})
  }
  currentLang = lang
  workerPromise = (async () => {
    const { createWorker } = await import('tesseract.js')
    return createWorker(lang, 1, {
      logger: (m) => {
        if (m.status === 'recognizing text') {
          onProgress?.({ phase: 'recognize', progress: m.progress })
        } else if (m.status?.includes('loading') || m.status?.includes('initializ')) {
          onProgress?.({ phase: 'load', progress: m.progress, status: m.status })
        }
      },
    })
  })()
  return workerPromise
}

export async function terminateOCR() {
  if (workerPromise) {
    const w = await workerPromise.catch(() => null)
    await w?.terminate?.().catch(() => {})
    workerPromise = null
    currentLang = null
  }
}

/**
 * 识别
 * @param {HTMLCanvasElement|HTMLImageElement|Blob} source
 * @param {{mode?:'print'|'hand', onProgress?:Function}} opts
 * @returns {Promise<{text:string, words:Array<{text:string, confidence:number}>}>}
 */
export async function recognize(source, { mode = 'print', onProgress } = {}) {
  const worker = await getWorker('eng', onProgress)

  await worker.setParameters(
    mode === 'print'
      ? {
          // 整块统一排版的文字；课本上划线的单词多是成行的
          tessedit_pageseg_mode: '6',
          // 只认字母和常见连字符，直接把中文和标点挡在外面
          tessedit_char_whitelist:
            "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-'",
          preserve_interword_spaces: '1',
        }
      : {
          // 手写行距不齐，用稀疏文本模式容错更好，且不做白名单限制
          tessedit_pageseg_mode: '11',
          tessedit_char_whitelist: '',
          preserve_interword_spaces: '1',
        }
  )

  const { data } = await worker.recognize(source)
  const words = (data.words || []).map((w) => ({
    text: w.text,
    confidence: Math.round(w.confidence ?? 0),
  }))
  return { text: data.text || '', words }
}

/* --------------------------- 结果清洗 --------------------------- */

/**
 * 把 OCR 原始结果整理成候选单词列表
 * - 只保留纯英文
 * - 过滤中文、数字、标点、乱码
 * - 去重，低置信度打标记让用户重点检查
 *
 * @returns {Array<{word:string, confidence:number, suspicious:boolean}>}
 */
export function toCandidates(result, { minLen = 2, minConfidence = 0 } = {}) {
  const out = []
  const seen = new Set()

  const push = (raw, conf) => {
    let w = String(raw || '')
      .replace(/[^a-zA-Z'’\-]/g, '') // 中文、数字、标点全部剔除
      .replace(/^['’\-]+|['’\-]+$/g, '')
    if (w.length < minLen) return
    if (w.length > 24) return
    // 全是辅音的基本是乱码（少数例外如 hmm、by 已被长度或元音规则覆盖）
    const hasVowel = /[aeiouyAEIOUY]/.test(w)
    if (!hasVowel && w.length > 2) return
    // 大小写混乱（aBcD）多半是识别噪声，统一小写但标记可疑
    const messyCase = /[a-z][A-Z]/.test(w) && !/^[A-Z]{2,}$/.test(w)
    if (!/^[A-Z]{2,}$/.test(w)) w = w.toLowerCase()

    const key = w.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)

    out.push({
      word: w,
      confidence: conf,
      suspicious: conf < 70 || messyCase || w.length <= 2,
    })
  }

  if (result.words?.length) {
    for (const w of result.words) {
      if (w.confidence < minConfidence) continue
      // 一个 token 里可能粘了多个词
      for (const piece of w.text.split(/[\s/|,;.]+/)) push(piece, w.confidence)
    }
  } else {
    for (const piece of String(result.text || '').split(/\s+/)) push(piece, 0)
  }

  return out
}
