// Minimal static file server for the built app (no dependencies).
// Usage: node scripts/serve.mjs <root> [port]
// Serves precompressed .gz siblings when the client accepts gzip, marks hashed
// assets immutable, and keeps index.html / sw.js uncached so updates land.

import { createServer } from 'node:http'
import { createReadStream, promises as fs } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'

const root = resolve(process.argv[2] ?? 'dist')
const port = Number(process.argv[3] ?? process.env.PORT ?? 8742)
const host = process.env.HOST ?? '127.0.0.1'

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

const NO_CACHE = new Set(['/index.html', '/sw.js', '/registerSW.js', '/manifest.webmanifest'])

async function stat(p) {
  try {
    return await fs.stat(p)
  } catch {
    return null
  }
}

const server = createServer(async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end()
      return
    }
    // Resolve the root on every request: it is a symlink swapped on deploy.
    const base = await fs.realpath(root)
    let path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
    if (path.endsWith('/')) path += 'index.html'
    let file = resolve(join(base, path))
    if (file !== base && !file.startsWith(base + sep)) {
      res.writeHead(403).end()
      return
    }
    let st = await stat(file)
    if (!st || !st.isFile()) {
      // Unknown paths fall back to the app shell (routing is hash-based anyway).
      if (extname(path)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found')
        return
      }
      path = '/index.html'
      file = join(base, 'index.html')
      st = await stat(file)
    }
    const headers = {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': NO_CACHE.has(path)
        ? 'no-cache'
        : path.startsWith('/assets/')
          ? 'public, max-age=31536000, immutable'
          : 'public, max-age=3600',
      Vary: 'Accept-Encoding',
    }
    let body = file
    let size = st.size
    if (/\bgzip\b/.test(req.headers['accept-encoding'] ?? '')) {
      const gz = await stat(file + '.gz')
      if (gz?.isFile()) {
        body = file + '.gz'
        size = gz.size
        headers['Content-Encoding'] = 'gzip'
      }
    }
    headers['Content-Length'] = size
    res.writeHead(200, headers)
    if (req.method === 'HEAD') res.end()
    else createReadStream(body).pipe(res)
  } catch (e) {
    console.error(e)
    if (!res.headersSent) res.writeHead(500)
    res.end()
  }
})

server.listen(port, host, () => console.log(`Serving ${root} on http://${host}:${port}`))
