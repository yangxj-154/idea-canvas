import zlib from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'

// CRC32 table
const crcTable = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const t = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0)
  return Buffer.concat([len, t, data, crc])
}

function makePNG(size) {
  const w = size
  const h = size
  const px = Buffer.alloc(w * h * 4) // RGBA, transparent default
  const set = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return
    const i = (y * w + x) * 4
    px[i] = r
    px[i + 1] = g
    px[i + 2] = b
    px[i + 3] = a
  }
  const disc = (cx, cy, rad, r, g, b) => {
    for (let y = -rad; y <= rad; y++)
      for (let x = -rad; x <= rad; x++)
        if (x * x + y * y <= rad * rad) set(cx + x, cy + y, r, g, b)
  }
  const line = (x0, y0, x1, y1, r, g, b, th = 4) => {
    const dx = x1 - x0
    const dy = y1 - y0
    const steps = Math.max(Math.abs(dx), Math.abs(dy))
    for (let s = 0; s <= steps; s++) {
      const x = Math.round(x0 + (dx * s) / steps)
      const y = Math.round(y0 + (dy * s) / steps)
      disc(x, y, th, r, g, b)
    }
  }
  const roundRect = (x0, y0, x1, y1, rad, r, g, b) => {
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const inX = x >= x0 + rad && x <= x1 - rad
        const inY = y >= y0 + rad && y <= y1 - rad
        if (inX || inY) {
          set(x, y, r, g, b)
          continue
        }
        const cx = x < x0 + rad ? x0 + rad : x1 - rad
        const cy = y < y0 + rad ? y0 + rad : y1 - rad
        const ddx = x - cx
        const ddy = y - cy
        if (ddx * ddx + ddy * ddy <= rad * rad) set(x, y, r, g, b)
      }
  }

  // background (dark slate rounded square)
  roundRect(0, 0, w, h, Math.round(size * 0.18), 15, 23, 42)

  const s = size / 512
  const discS = (cx, cy, rad, col) =>
    disc(Math.round(cx * s), Math.round(cy * s), Math.round(rad * s), col[0], col[1], col[2])
  const lineS = (x0, y0, x1, y1, col, th) =>
    line(
      Math.round(x0 * s),
      Math.round(y0 * s),
      Math.round(x1 * s),
      Math.round(y1 * s),
      col[0],
      col[1],
      col[2],
      Math.round(th * s),
    )

  const blue = [96, 165, 250]
  const green = [52, 211, 153]
  const orange = [251, 191, 36]
  const pink = [244, 114, 182]
  const edge = [203, 213, 225]

  // edges
  lineS(140, 160, 380, 140, edge, 6)
  lineS(140, 160, 260, 360, edge, 6)
  lineS(260, 360, 390, 380, edge, 6)
  lineS(380, 140, 390, 380, edge, 6)
  // nodes
  discS(140, 160, 36, blue)
  discS(380, 140, 30, green)
  discS(260, 360, 40, orange)
  discS(390, 380, 26, pink)

  // encode PNG, filter type 0 per scanline
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0
    px.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  const idat = zlib.deflateSync(raw)
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
  return png
}

mkdirSync('public', { recursive: true })
writeFileSync('public/icon-192.png', makePNG(192))
writeFileSync('public/icon-512.png', makePNG(512))
console.log('PWA icons generated: public/icon-192.png, public/icon-512.png')
