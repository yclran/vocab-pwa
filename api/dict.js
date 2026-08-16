/**
 * Vercel Serverless Function —— 词典/中文释义代理
 *
 * 复用 server/dictProxy.js 的核心逻辑（环境无关），这里只做 HTTP 适配：
 *   - 前端 POST /api/dict  { words: [...] }  -> 返回 { ok, provider, data }
 *   - 默认走 youdao-dict（有道词典网页接口，免密钥），无需任何环境变量即可拿到中文释义
 *
 * 部署：把整个仓库推到 Vercel 即自动识别 api/ 目录为函数。
 */
import { handleDictRequest } from '../server/dictProxy.js'

function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => resolve(data))
    req.on('error', () => resolve(''))
  })
}

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

export default async function handler(req, res) {
  // 宽松 CORS：同源通常不需要，但加上无害，方便日后前端/后端分域部署
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    res.end()
    return
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, message: '只支持 POST' })
    return
  }

  const text = await readBody(req)
  let payload
  try {
    payload = JSON.parse(text || '{}')
  } catch {
    sendJson(res, 400, { ok: false, message: '请求体不是合法 JSON' })
    return
  }

  const { status, body } = await handleDictRequest(payload, process.env)
  sendJson(res, status, body)
}
