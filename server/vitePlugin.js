/**
 * 把 dictProxy 挂到 Vite dev server 上。
 * 部署到 Vercel/CF 时删掉这个文件即可，dictProxy.js 本身可直接复用。
 */
import { handleDictRequest, handleStatusRequest } from './dictProxy.js'

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 1e6) {
        reject(new Error('请求体过大'))
        req.destroy()
      }
    })
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function send(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

export function dictProxyPlugin(env) {
  return {
    name: 'vocab-dict-proxy',
    configureServer(server) {
      server.middlewares.use('/api/dict/status', (req, res, next) => {
        if (req.method !== 'GET') return next()
        const { status, body } = handleStatusRequest(env)
        send(res, status, body)
      })

      server.middlewares.use('/api/dict', async (req, res, next) => {
        if (req.method !== 'POST') return next()
        try {
          const payload = await readJsonBody(req)
          const { status, body } = await handleDictRequest(payload, env)
          send(res, status, body)
        } catch (err) {
          send(res, 400, { ok: false, message: err.message })
        }
      })
    },
  }
}
