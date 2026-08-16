/**
 * Vercel Serverless Function —— 词典后端状态探测
 *
 * 前端 GET /api/dict/status 用来在设置页展示当前用的是哪个中文释义源。
 * youdao-dict（默认）无需密钥，只要函数部署成功就算可用。
 */
import { handleStatusRequest } from '../../server/dictProxy.js'

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    res.end()
    return
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ ok: false, message: '只支持 GET' }))
    return
  }

  const { status, body } = handleStatusRequest(process.env)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}
