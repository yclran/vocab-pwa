/**
 * 词典 / 翻译代理 —— 环境无关的核心逻辑
 *
 * 为什么需要它：
 *   有道、百度的翻译接口都不返回 CORS 头，浏览器无法直连；
 *   而且 appSecret 一旦写进前端代码就等于公开。
 *   所以必须由服务端签名 + 转发。
 *
 * 这个文件不依赖 Vite，也不依赖 Node 的 http 对象，
 * 只接收一个普通对象、返回一个普通对象。
 * 因此它可以同时被这三种环境复用：
 *   1. 本地开发     -> server/vitePlugin.js  (当前使用)
 *   2. Vercel      -> api/dict.js  中 export default (req,res)=>...
 *   3. CF Workers  -> fetch handler 中直接调用
 */

import { createHash, randomUUID } from 'node:crypto'

/* ------------------------------------------------------------------ *
 * 有道词典网页接口（默认 provider，零配置、无需任何 key）
 *
 * 端点：https://dict.youdao.com/jsonapi?q=<word>&dicts=...
 *
 * 实测（2026-08-10，本机 Node 直连）：
 *   - 不带 Origin 头请求 → HTTP 200，返回完整 JSON
 *   - 带 Origin 头请求   → HTTP 403 "Invalid CORS request"
 *   因此浏览器无法直连，必须由服务端转发；但服务端不需要账号密钥。
 *
 * 返回可用字段：
 *   ec.word[0].usphone / ukphone      美音 / 英音音标（无斜杠）
 *   ec.word[0].trs[].tr[].l.i[]       分词性中文释义，形如 "v. 抛弃，遗弃；…"
 *   ec.word[0].wfs[].wf               词形变化（第三人称单数 / 过去式 / …）
 *   ec.exam_type[]                    考纲标签（初中 / 高中 / CET4 / 考研 / …）
 *
 * ⚠️ 这是有道词典网页端使用的接口，非官方开放平台产品，
 *    没有公开的服务条款与配额承诺，可能随时变更或限流。
 *    仅适合家庭自用的低频调用；若要商用请改用官方付费 API。
 * ------------------------------------------------------------------ */

const YOUDAO_DICT_URL = 'https://dict.youdao.com/jsonapi'
const DICTS_PARAM = JSON.stringify({ count: 1, dicts: [['ec']] })

/** 从 "v. 抛弃，遗弃；离开" 里剥出词性和释义 */
const POS_HEAD = /^\s*(n|v|vt|vi|adj|adv|prep|pron|conj|art|num|int|interj|aux|abbr|pl|modal)\s*\.\s*/i

function splitPosLine(line) {
  const s = String(line || '').trim()
  if (!s) return null
  const m = s.match(POS_HEAD)
  if (m) {
    return { pos: `${m[1].toLowerCase()}.`, zh: s.slice(m[0].length).trim() }
  }
  // 形如「【名】（Seem）（英）西姆（人名）」这类没有标准词性前缀的，整条留作释义
  return { pos: '', zh: s }
}

function normPhonetic(t) {
  const s = String(t || '').trim()
  if (!s) return ''
  return /^[/[]/.test(s) ? s : `/${s}/`
}

async function fetchYoudaoDict(word, { timeout = 9000 } = {}) {
  const url = `${YOUDAO_DICT_URL}?q=${encodeURIComponent(word)}&dicts=${encodeURIComponent(DICTS_PARAM)}`
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeout)
  try {
    const resp = await fetch(url, {
      signal: ac.signal,
      headers: {
        // 不带 Origin/Referer，避免触发它的 CORS 拦截
        'User-Agent': 'Mozilla/5.0 (compatible; vocab-pwa/1.0)',
        Accept: 'application/json,text/plain,*/*',
      },
    })
    if (!resp.ok) return { ok: false, reason: 'http', message: `HTTP ${resp.status}` }
    const j = await resp.json()

    const w = j?.ec?.word?.[0]
    if (!w) return { ok: false, notFound: true, reason: 'not-found' }

    const meanings = []
    for (const trs of w.trs || []) {
      for (const tr of trs.tr || []) {
        for (const line of tr?.l?.i || []) {
          // i[] 里偶尔混入对象（带 sentence 的富文本），只取纯字符串
          if (typeof line !== 'string') continue
          const parsed = splitPosLine(line)
          if (parsed?.zh) meanings.push(parsed)
        }
      }
    }
    if (!meanings.length) return { ok: false, notFound: true, reason: 'no-definition' }

    const forms = (w.wfs || [])
      .map((x) => x?.wf)
      .filter((x) => x?.name && x?.value)
      .map((x) => ({ name: x.name, value: x.value }))

    return {
      ok: true,
      data: {
        zh: meanings.map((m) => (m.pos ? `${m.pos} ${m.zh}` : m.zh)),
        meanings,
        phonetics: { uk: normPhonetic(w.ukphone), us: normPhonetic(w.usphone) },
        exam: Array.isArray(j?.ec?.exam_type) ? j.ec.exam_type : [],
        forms,
        source: 'youdao-dict',
      },
    }
  } catch (err) {
    const reason = err?.name === 'AbortError' ? 'timeout' : 'network'
    return { ok: false, reason, message: err?.message || '请求失败' }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 批量查询。这个接口只支持单词查询，所以服务端做并发池。
 * 并发压到 4，避免被判定为异常流量。
 */
async function callYoudaoDict(words) {
  const result = {}
  const errors = []
  const queue = [...words]

  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length) {
      const w = queue.shift()
      const r = await fetchYoudaoDict(w)
      if (r.ok) result[w] = r.data
      else if (!r.notFound) errors.push({ word: w, reason: r.reason, message: r.message })
    }
  })
  await Promise.all(workers)

  // 全军覆没且都是网络错误 → 判定为 provider 不可用，让前端知道是网络问题而非查无此词
  if (!Object.keys(result).length && errors.length === words.length) {
    return { ok: false, reason: 'provider-down', message: errors[0]?.message || '有道词典接口不可达' }
  }
  return { ok: true, data: result, errors }
}

/* ------------------------------------------------------------------ *
 * 有道智云 文本翻译 API
 * 文档：https://ai.youdao.com/DOCSIRMA/html/trans/api/wbfy/index.html
 *
 * ⚠️ 重要限制（来自官方文档「版本更新记录」）：
 *    2024.04.22 v3.0.0「下线接口内相关的词典数据内容」
 *    也就是说本接口现在只返回机器翻译结果（translation 数组），
 *    不再返回音标 / 词性 / 分词性多释义等词典字段。
 *    查 good 只会得到 ["好"]，而不是 "adj. 好的；n. 好处"。
 *    音标和发音请依赖 Free Dictionary provider 补齐。
 *
 * ⚠️ 计费：官方为付费服务，仅赠送 50 元体验金，非永久免费。
 * ------------------------------------------------------------------ */

function youdaoTruncate(q) {
  const len = q.length
  if (len <= 20) return q
  return q.substring(0, 10) + len + q.substring(len - 10, len)
}

async function callYoudao(words, { appKey, appSecret }) {
  if (!appKey || !appSecret) {
    return { ok: false, reason: 'no-credentials' }
  }

  // 有道支持用 \n 连接多个 query 一次性提交，省调用次数
  const q = words.join('\n')
  const salt = randomUUID()
  const curtime = String(Math.round(Date.now() / 1000))
  const signStr = appKey + youdaoTruncate(q) + salt + curtime + appSecret
  const sign = createHash('sha256').update(signStr, 'utf8').digest('hex')

  const body = new URLSearchParams({
    q,
    from: 'en',
    to: 'zh-CHS',
    appKey,
    salt,
    sign,
    signType: 'v3',
    curtime,
  })

  const resp = await fetch('https://openapi.youdao.com/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })

  const data = await resp.json()

  if (data.errorCode !== '0') {
    return {
      ok: false,
      reason: 'youdao-error',
      errorCode: data.errorCode,
      message: YOUDAO_ERRORS[data.errorCode] || `有道返回错误码 ${data.errorCode}`,
    }
  }

  // translation 与输入的 \n 分段一一对应
  const translations = data.translation || []
  const result = {}
  words.forEach((w, i) => {
    const t = translations[i]
    if (t && t.toLowerCase() !== w.toLowerCase()) {
      result[w] = { zh: [t], source: 'youdao' }
    }
  })

  return { ok: true, data: result }
}

const YOUDAO_ERRORS = {
  108: '应用ID无效，请检查 YOUDAO_APP_KEY',
  202: '签名校验失败，请检查 YOUDAO_APP_SECRET',
  401: '账户已欠费，请到有道智云控制台充值',
  411: '访问频率受限，请稍后再试',
  412: '长请求过于频繁，请稍后再试',
}

/* ------------------------------------------------------------------ *
 * 百度翻译开放平台
 * 文档：https://api.fanyi.baidu.com/doc/21
 * 签名：sign = md5(appid + q + salt + 密钥)
 * 同样只返回机翻结果，无词性无音标。
 * ------------------------------------------------------------------ */

async function callBaidu(words, { appId, appSecret }) {
  if (!appId || !appSecret) {
    return { ok: false, reason: 'no-credentials' }
  }

  const q = words.join('\n')
  const salt = String(Date.now())
  const sign = createHash('md5')
    .update(appId + q + salt + appSecret, 'utf8')
    .digest('hex')

  const params = new URLSearchParams({
    q,
    from: 'en',
    to: 'zh',
    appid: appId,
    salt,
    sign,
  })

  const resp = await fetch('https://fanyi-api.baidu.com/api/trans/vip/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  })

  const data = await resp.json()

  if (data.error_code) {
    return {
      ok: false,
      reason: 'baidu-error',
      errorCode: data.error_code,
      message: data.error_msg || `百度返回错误码 ${data.error_code}`,
    }
  }

  const result = {}
  for (const item of data.trans_result || []) {
    const src = item.src
    if (item.dst && item.dst.toLowerCase() !== src.toLowerCase()) {
      result[src] = { zh: [item.dst], source: 'baidu' }
    }
  }

  return { ok: true, data: result }
}

/* ------------------------------------------------------------------ *
 * 统一入口
 * ------------------------------------------------------------------ */

/**
 * @param {{words: string[]}} payload
 * @param {Record<string,string>} env  环境变量
 * @returns {Promise<{status:number, body:object}>}
 */
export async function handleDictRequest(payload, env) {
  const words = Array.isArray(payload?.words)
    ? payload.words.map((w) => String(w).trim()).filter(Boolean).slice(0, 50)
    : []

  if (words.length === 0) {
    return { status: 400, body: { ok: false, message: 'words 不能为空' } }
  }

  const provider = resolveProvider(env)

  try {
    let res
    if (provider === 'baidu') {
      res = await callBaidu(words, {
        appId: env.BAIDU_TRANSLATE_APPID,
        appSecret: env.BAIDU_TRANSLATE_SECRET,
      })
    } else if (provider === 'youdao-api') {
      res = await callYoudao(words, {
        appKey: env.YOUDAO_APP_KEY,
        appSecret: env.YOUDAO_APP_SECRET,
      })
    } else {
      res = await callYoudaoDict(words)
    }

    if (!res.ok && res.reason === 'no-credentials') {
      // 没配密钥不算错误 —— 前端会自动降级到只用 Free Dictionary
      return {
        status: 200,
        body: {
          ok: true,
          configured: false,
          provider,
          data: {},
          message: `未配置 ${provider} 密钥，已跳过中文释义补全`,
        },
      }
    }

    if (!res.ok) {
      return {
        status: 502,
        body: { ok: false, provider, configured: true, ...res },
      }
    }

    return {
      status: 200,
      body: { ok: true, configured: true, provider, data: res.data },
    }
  } catch (err) {
    return {
      status: 502,
      body: { ok: false, provider, message: `代理请求失败：${err.message}` },
    }
  }
}

/**
 * 决定用哪个 provider。
 *
 * 规则：显式指定优先；否则谁配了密钥用谁；都没配就用零配置的有道词典网页接口。
 * 也就是说「什么都不配」也能拿到分词性中文释义 —— 这是默认路径。
 */
function resolveProvider(env) {
  const explicit = String(env.TRANSLATE_PROVIDER || '').toLowerCase().trim()
  if (explicit === 'baidu' || explicit === 'youdao-api' || explicit === 'youdao-dict') {
    return explicit
  }
  if (env.BAIDU_TRANSLATE_APPID && env.BAIDU_TRANSLATE_SECRET) return 'baidu'
  if (env.YOUDAO_APP_KEY && env.YOUDAO_APP_SECRET) return 'youdao-api'
  return 'youdao-dict'
}

const PROVIDER_LABEL = {
  'youdao-dict': '有道词典（免密钥）',
  'youdao-api': '有道智云翻译 API',
  baidu: '百度翻译 API',
}

/** 供设置页探测当前后端配置状态 */
export function handleStatusRequest(env) {
  const provider = resolveProvider(env)

  // youdao-dict 不需要密钥，只要代理进程在跑就算可用
  const configured =
    provider === 'youdao-dict'
      ? true
      : provider === 'baidu'
        ? Boolean(env.BAIDU_TRANSLATE_APPID && env.BAIDU_TRANSLATE_SECRET)
        : Boolean(env.YOUDAO_APP_KEY && env.YOUDAO_APP_SECRET)

  return {
    status: 200,
    body: {
      ok: true,
      provider,
      label: PROVIDER_LABEL[provider] || provider,
      configured,
      keyless: provider === 'youdao-dict',
      note:
        provider === 'youdao-dict'
          ? '正在使用有道词典网页接口，无需密钥，可返回分词性中文释义、音标与考纲标签'
          : configured
            ? '中文释义补全已启用'
            : '未配置翻译密钥，中文释义需导入时自带或手动填写',
    },
  }
}
