/**
 * 中文释义补全 —— 走本地/云端代理 /api/dict
 *
 * 为什么不直连：有道、百度翻译接口都不返回 CORS 头，
 * 且签名需要 appSecret，写进前端等于公开密钥。
 * 所以由 server/dictProxy.js 在服务端签名转发，前端只认这个统一路径。
 *
 * 没配密钥时后端返回 { configured:false }，前端静默降级，不报错。
 *
 * ⚠️ 已知质量限制：有道 v3.0.0（2024-04-22）已下线接口内的词典数据，
 *    现在只返回机器翻译结果，拿不到分词性中文释义和音标。
 *    音标/词性/发音一律以 Free Dictionary 为准。
 */

const ENDPOINT = '/api/dict'
const STATUS_ENDPOINT = '/api/dict/status'

let statusCache = null

export async function checkStatus({ force = false } = {}) {
  if (statusCache && !force) return statusCache
  try {
    const resp = await fetch(STATUS_ENDPOINT)
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    statusCache = await resp.json()
  } catch {
    // 纯静态托管环境下没有这个接口，属于正常情况
    statusCache = {
      ok: true,
      provider: 'none',
      configured: false,
      note: '当前部署没有翻译代理，中文释义需导入时自带或手动填写',
    }
  }
  return statusCache
}

/**
 * 批量翻译（一次最多 50 个词，由后端限制）
 * @param {string[]} words
 * @returns {Promise<{ok:boolean, configured:boolean, data:Record<string,{zh:string[]}>, message?:string}>}
 */
export async function translateBatch(words) {
  const list = [...new Set(words.map((w) => String(w).trim()).filter(Boolean))]
  if (!list.length) return { ok: true, configured: true, data: {} }

  try {
    const resp = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ words: list.slice(0, 50) }),
    })
    const json = await resp.json().catch(() => ({}))
    if (!resp.ok || json.ok === false) {
      return {
        ok: false,
        configured: json.configured !== false,
        data: {},
        message: json.message || `翻译代理返回 HTTP ${resp.status}`,
      }
    }
    return { ok: true, configured: json.configured !== false, data: json.data || {} }
  } catch (err) {
    return { ok: false, configured: false, data: {}, message: `翻译代理不可用：${err.message}` }
  }
}
