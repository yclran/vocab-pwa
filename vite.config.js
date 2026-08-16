import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'
import { dictProxyPlugin } from './server/vitePlugin.js'

export default defineConfig(({ mode }) => {
  // 把 .env / .env.local 里的密钥读进 Node 侧（不会进入前端 bundle）
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [
      vue(),

      // 词典代理中间件：本地开发时提供 /api/dict
      // 密钥只在 Node 进程里，前端代码看不到
      dictProxyPlugin(env),

      // PWA 支持：桌面图标、离线缓存
      // 沙箱构建环境缺少 workbox 依赖（@rollup/plugin-babel）时，
      // 用 NO_PWA=1 关闭自动 SW 生成，改用仓库自带的手写 dist-prod/sw.js（可控、重建即更新）。
      // 在依赖齐全的环境直接用 `npm run build` 即可生成标准 workbox SW。
      process.env.NO_PWA
        ? null
        : VitePWA({
        registerType: 'autoUpdate',
        // index.html 已手动注册 /sw.js，避免插件重复注入注册脚本
        injectRegister: false,
        includeAssets: ['favicon.svg', 'icons/*.png'],
        manifest: {
          name: '背单词',
          short_name: '背单词',
          description: '家庭自用背单词工具',
          theme_color: '#2563eb',
          background_color: '#f8fafc',
          display: 'standalone',
          orientation: 'portrait',
          start_url: '/',
          scope: '/',
          lang: 'zh-CN',
          icons: [
            { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
            {
              src: 'icons/icon-512-maskable.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
          // 重建后用新 SW 立即接管，并清理旧版本缓存，避免旧产物一直刷新不出来（修复 SW 缓存不更新）
          cleanupOutdatedCaches: true,
          navigateFallback: 'index.html',
          // tesseract 的 wasm/训练数据体积大，放宽单文件上限
          maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
          runtimeCaching: [
            {
              // 发音音频：缓存优先，缓存后断网可播
              urlPattern: /^https:\/\/.*\.(?:mp3|ogg|wav)$/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'audio-cache',
                expiration: { maxEntries: 2000, maxAgeSeconds: 60 * 60 * 24 * 365 },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
            {
              // 词典 API：网络优先，失败回落缓存
              urlPattern: /^https:\/\/api\.dictionaryapi\.dev\//,
              handler: 'NetworkFirst',
              options: {
                cacheName: 'dict-api-cache',
                networkTimeoutSeconds: 8,
                expiration: { maxEntries: 5000, maxAgeSeconds: 60 * 60 * 24 * 365 },
              },
            },
            {
              // tesseract 的 wasm 与语言包
              urlPattern: /^https:\/\/(cdn\.jsdelivr\.net|unpkg\.com|tessdata\.projectnaptha\.com)\//,
              handler: 'CacheFirst',
              options: {
                cacheName: 'ocr-assets',
                expiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 * 24 * 365 },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
          ],
        },
        devOptions: {
          // 开发模式也启用 SW，方便在手机上直接验证 PWA 行为
          enabled: false,
        },
      }),
    ],

    server: {
      host: true, // 允许同一 WiFi 下手机访问
      port: 5173,
    },

    build: {
      target: 'es2020',
      outDir: 'dist',
      // 沙箱构建无法删除 dist-prod（安全删除 shim 会拦截），用 NO_PWA 构建时改为覆盖而非清空，
      // 只更新 index.html 与新哈希资源，旧哈希文件无害（index.html 只引用新哈希）。
      emptyOutDir: process.env.NO_PWA ? false : true,
      // 沙箱构建环境无法覆盖写入 dist-prod 内已存在文件（EPERM），
      // 故 NO_PWA 构建统一产物到全新目录后再整体替换（见 scripts/build-prod.mjs）。
      publicDir: 'public',
      rollupOptions: {
        output: {
          manualChunks: {
            // OCR 体积很大，单独切包，不进首屏
            ocr: ['tesseract.js'],
            docx: ['mammoth'],
          },
        },
      },
    },
  }
})
