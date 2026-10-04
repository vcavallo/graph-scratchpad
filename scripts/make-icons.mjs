// Draws the app icons as PNGs with no dependencies (signed-distance shapes,
// 4x4 supersampling, a minimal PNG encoder). Run: npm run icons

import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const BLUEPRINT = [0x16, 0x3a, 0x63]
const GRID = [0xff, 0xff, 0xff]
const INK = [0xf4, 0xf7, 0xf8]
const PLACE = [0x8f, 0xe0, 0xab]

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const sdCircle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) - r
const sdRoundRect = (x, y, x0, y0, x1, y1, r) => {
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  const hx = (x1 - x0) / 2 - r
  const hy = (y1 - y0) / 2 - r
  const qx = Math.abs(x - cx) - hx
  const qy = Math.abs(y - cy) - hy
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}
const sdCapsule = (x, y, x0, x1, cy, h) => sdRoundRect(x, y, x0, cy - h / 2, x1, cy + h / 2, h / 2)

/**
 * Returns [rgb, alpha] layers for a point in unit coordinates.
 * `inset` scales the artwork toward the centre (for maskable icons).
 */
function shade(x, y, { rounded, inset }) {
  const layers = []
  const bg = rounded ? sdRoundRect(x, y, 0, 0, 1, 1, 0.22) : -1
  if (bg > 0) return layers
  layers.push([BLUEPRINT, 1])
  // Grid paper.
  const g = 1 / 10
  const gx = Math.abs(((x + g / 2) % g) - g / 2)
  const gy = Math.abs(((y + g / 2) % g) - g / 2)
  if (Math.min(gx, gy) < 0.0045) layers.push([GRID, 0.13])
  // Artwork in an inset frame.
  const u = (x - 0.5) / inset + 0.5
  const v = (y - 0.5) / inset + 0.5
  const shapes = [
    [sdCircle(u, v, 0.25, 0.3, 0.045), INK],
    [sdCapsule(u, v, 0.35, 0.76, 0.3, 0.06), INK],
    [sdCircle(u, v, 0.37, 0.5, 0.045), INK],
    [sdCapsule(u, v, 0.47, 0.8, 0.5, 0.11), PLACE],
    [sdCircle(u, v, 0.25, 0.7, 0.045), INK],
    [sdCapsule(u, v, 0.35, 0.66, 0.7, 0.06), INK],
  ]
  for (const [d, color] of shapes) if (d < 0) layers.push([color, 1])
  return layers
}

function render(size, opts) {
  const buf = Buffer.alloc(size * size * 4)
  const ss = 4
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0
      let gch = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss) / size
          const y = (py + (sy + 0.5) / ss) / size
          let cr = 0
          let cg = 0
          let cb = 0
          let ca = 0
          for (const [c, al] of shade(x, y, opts)) {
            cr = cr * (1 - al) + c[0] * al
            cg = cg * (1 - al) + c[1] * al
            cb = cb * (1 - al) + c[2] * al
            ca = ca + al * (1 - ca)
          }
          r += cr * ca
          gch += cg * ca
          b += cb * ca
          a += ca
        }
      }
      const i = (py * size + px) * 4
      const n = ss * ss
      buf[i + 3] = Math.round((a / n) * 255)
      if (a > 0) {
        buf[i] = Math.round(r / a)
        buf[i + 1] = Math.round(gch / a)
        buf[i + 2] = Math.round(b / a)
      }
    }
  }
  return png(size, buf)
}

const out = (name, size, opts) => {
  writeFileSync(new URL(`../public/${name}`, import.meta.url), render(size, opts))
  console.log('wrote public/' + name)
}
out('pwa-192.png', 192, { rounded: true, inset: 1 })
out('pwa-512.png', 512, { rounded: true, inset: 1 })
out('maskable-512.png', 512, { rounded: false, inset: 0.78 })
out('apple-touch-icon.png', 180, { rounded: false, inset: 0.86 })

const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('')
writeFileSync(
  new URL('../public/favicon.svg', import.meta.url),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="22" fill="${hex(BLUEPRINT)}"/>
  <circle cx="25" cy="30" r="4.5" fill="${hex(INK)}"/>
  <rect x="35" y="27" width="41" height="6" rx="3" fill="${hex(INK)}"/>
  <circle cx="37" cy="50" r="4.5" fill="${hex(INK)}"/>
  <rect x="47" y="44.5" width="33" height="11" rx="5.5" fill="${hex(PLACE)}"/>
  <circle cx="25" cy="70" r="4.5" fill="${hex(INK)}"/>
  <rect x="35" y="67" width="31" height="6" rx="3" fill="${hex(INK)}"/>
</svg>
`,
)
console.log('wrote public/favicon.svg')
