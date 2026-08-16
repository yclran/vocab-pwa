/**
 * 生成 PWA 图标（纯 Node，不引第三方依赖）
 *
 * 手写一个最小 PNG 编码器：IHDR + IDAT(zlib) + IEND，颜色类型 6 (RGBA8)。
 * 图案：品牌蓝圆角方块 + 白色字母 A + 下方一道白色底线。
 * 抗锯齿用 3x3 超采样。
 *
 * 用法：node scripts/gen-icons.mjs
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(__dirname, '../public/icons')

/* ----------------------------- PNG 编码 ----------------------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  // 每行前面加一个 filter 字节 0
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* ----------------------------- 几何 ----------------------------- */

/** 点到线段距离 */
function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1
  const dy = y2 - y1
  const len2 = dx * dx + dy * dy
  let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0
  t = Math.max(0, Math.min(1, t))
  const cx = x1 + t * dx
  const cy = y1 + t * dy
  return Math.hypot(px - cx, py - cy)
}

/** 圆角矩形内部判定 */
function inRoundRect(px, py, x, y, w, h, r) {
  if (px < x || py < y || px > x + w || py > y + h) return false
  const cx = Math.min(Math.max(px, x + r), x + w - r)
  const cy = Math.min(Math.max(py, y + r), y + h - r)
  return Math.hypot(px - cx, py - cy) <= r
}

const BRAND = [37, 99, 235] // #2563eb
const BRAND_DARK = [29, 78, 216] // #1d4ed8

/**
 * @param {number} size 边长
 * @param {{maskable?:boolean}} opts maskable 时图案缩到安全区(80%)内，背景铺满
 */
function drawIcon(size, { maskable = false } = {}) {
  const SS = 3 // 超采样
  const buf = Buffer.alloc(size * size * 4)

  // 图案安全区
  const inset = maskable ? size * 0.1 : 0
  const cw = size - inset * 2
  const radius = maskable ? 0 : size * 0.22

  // 字母 A 的三条笔画（相对安全区）
  const apexX = inset + cw * 0.5
  const topY = inset + cw * 0.24
  const baseY = inset + cw * 0.72
  const halfW = cw * 0.2
  const stroke = cw * 0.085

  // 底部横线
  const barX = inset + cw * 0.26
  const barW = cw * 0.48
  const barY = inset + cw * 0.8
  const barH = cw * 0.055

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rAcc = 0
      let gAcc = 0
      let bAcc = 0
      let aAcc = 0

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS
          const py = y + (sy + 0.5) / SS

          // 背景
          let bg = null
          if (maskable) {
            bg = BRAND
          } else if (inRoundRect(px, py, 0, 0, size, size, radius)) {
            // 轻微竖向渐变，避免死板
            const t = py / size
            bg = [
              Math.round(BRAND[0] + (BRAND_DARK[0] - BRAND[0]) * t),
              Math.round(BRAND[1] + (BRAND_DARK[1] - BRAND[1]) * t),
              Math.round(BRAND[2] + (BRAND_DARK[2] - BRAND[2]) * t),
            ]
          }

          if (!bg) continue // 圆角外，透明

          // 前景：字母 A + 底线
          const half = stroke / 2
          const onA =
            distToSeg(px, py, apexX - halfW, baseY, apexX, topY) <= half ||
            distToSeg(px, py, apexX + halfW, baseY, apexX, topY) <= half ||
            distToSeg(
              px,
              py,
              apexX - halfW * 0.5,
              baseY - (baseY - topY) * 0.32,
              apexX + halfW * 0.5,
              baseY - (baseY - topY) * 0.32
            ) <= half * 0.8
          const onBar = inRoundRect(px, py, barX, barY, barW, barH, barH / 2)

          const c = onA || onBar ? [255, 255, 255] : bg
          rAcc += c[0]
          gAcc += c[1]
          bAcc += c[2]
          aAcc += 255
        }
      }

      const n = SS * SS
      const i = (y * size + x) * 4
      const a = aAcc / n
      if (a > 0) {
        // 已经是「覆盖在背景上」的颜色，按覆盖率求平均即可
        buf[i] = Math.round(rAcc / (aAcc / 255) / 1)
        buf[i + 1] = Math.round(gAcc / (aAcc / 255) / 1)
        buf[i + 2] = Math.round(bAcc / (aAcc / 255) / 1)
        buf[i + 3] = Math.round(a)
      }
    }
  }

  return encodePNG(size, size, buf)
}

/* ----------------------------- 输出 ----------------------------- */

mkdirSync(OUT_DIR, { recursive: true })

const files = [
  ['icon-192.png', drawIcon(192)],
  ['icon-512.png', drawIcon(512)],
  ['icon-512-maskable.png', drawIcon(512, { maskable: true })],
  ['apple-touch-icon.png', drawIcon(180, { maskable: true })],
]

for (const [name, data] of files) {
  writeFileSync(resolve(OUT_DIR, name), data)
  console.log(`✓ ${name}  ${(data.length / 1024).toFixed(1)} KB`)
}

// favicon 用 SVG，体积小且清晰
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="113" fill="#2563eb"/>
  <path d="M154 369 L256 143 L358 369" fill="none" stroke="#fff" stroke-width="44" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M196 288 H316" fill="none" stroke="#fff" stroke-width="35" stroke-linecap="round"/>
  <rect x="133" y="410" width="246" height="28" rx="14" fill="#fff"/>
</svg>
`
writeFileSync(resolve(__dirname, '../public/favicon.svg'), favicon)
console.log('✓ favicon.svg')
