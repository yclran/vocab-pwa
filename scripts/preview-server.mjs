// 本地预览服务器：托管 dist-prod 静态产物
// 用 Node 内置模块实现，双栈监听（IPv4 + IPv6），并带 SPA 路由回退
//
// 同时挂载 /api/dict 词典代理 —— 与 vite dev 完全同一套逻辑（server/dictProxy.js），
// 所以预览构建产物时也能拿到中文释义，不用非得跑 npm run dev。
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { handleDictRequest, handleStatusRequest } from '../server/dictProxy.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', 'dist-prod')
const PORT = Number(process.env.PORT || 8080)

/** 读取 .env.local / .env 里的密钥（可选，没有也能跑） */
function loadEnvFiles() {
  const env = { ...process.env }
  for (const name of ['.env', '.env.local']) {
    const f = path.resolve(__dirname, '..', name)
    if (!fs.existsSync(f)) continue
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i)
      if (!m) continue
      env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  }
  return env
}
const ENV = loadEnvFiles()

function readBody(req, limit = 1024 * 256) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': buf.length,
  })
  res.end(buf)
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.txt': 'text/plain; charset=utf-8',
}

function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'Cache-Control': 'no-cache', ...headers })
  res.end(body)
}

const server = http.createServer(async (req, res) => {
  let urlPath
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
  } catch {
    return send(res, 400, 'Bad Request')
  }

  /* ---------------- 词典代理 ---------------- */
  if (urlPath === '/api/dict/status') {
    const { status, body } = handleStatusRequest(ENV)
    return sendJson(res, status, body)
  }

  if (urlPath === '/api/dict') {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, message: '只支持 POST' })
    try {
      const raw = await readBody(req)
      const payload = JSON.parse(raw || '{}')
      const { status, body } = await handleDictRequest(payload, ENV)
      return sendJson(res, status, body)
    } catch (e) {
      return sendJson(res, 400, { ok: false, message: `请求解析失败：${e.message}` })
    }
  }

  // 阻止路径穿越
  const target = path.resolve(ROOT, '.' + urlPath)
  if (!target.startsWith(ROOT)) return send(res, 403, 'Forbidden')

  let filePath = target
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html')
  }

  // SPA 回退：不存在且没有扩展名 → 交给 index.html 由前端路由处理
  if (!fs.existsSync(filePath)) {
    if (!path.extname(urlPath)) {
      filePath = path.join(ROOT, 'index.html')
    } else {
      return send(res, 404, 'Not Found')
    }
  }

  const ext = path.extname(filePath).toLowerCase()
  const type = MIME[ext] || 'application/octet-stream'
  try {
    send(res, 200, fs.readFileSync(filePath), { 'Content-Type': type })
  } catch (e) {
    send(res, 500, 'Internal Error: ' + e.message)
  }
})

// 不指定 host → Node 监听 ::（双栈），localhost 无论解析到 127.0.0.1 还是 ::1 都能连上
server.listen(PORT, () => {
  const { body } = handleStatusRequest(ENV)
  console.log(`[preview] serving ${ROOT}`)
  console.log(`[preview] http://localhost:${PORT}`)
  console.log(`[preview] 词典代理 /api/dict -> ${body.label}${body.keyless ? '（无需密钥）' : ''}`)
})
