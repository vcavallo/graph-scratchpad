// Static file server for the built app, plus the sync endpoint (no dependencies).
// Usage: node server/serve.mjs <root> [port]
// Serves precompressed .gz siblings when the client accepts gzip, marks hashed
// assets immutable, and keeps index.html / sw.js uncached so updates land.
//
// Sync (optional), at /api/sync:
//   SYNC_DB=/path/sync.sqlite3     keep the sync database here (Node's built-in SQLite)
//   SYNC_UPSTREAM=https://host     or pass /api/sync through to another server
// Daily backups of the sync database go to <dir of SYNC_DB>/backups (7 kept).
// Link labels by Claude Haiku (server/relations-ai.mjs), if an API key is present:
//   RELATIONS_KEY_FILE=/path/key   default: <dir of SYNC_DB>/../anthropic-api-key
//   RELATIONS_MODEL, RELATIONS_MAX_CALLS_PER_DAY (default 300)
// Meant to sit behind `tailscale serve`: it listens on localhost only, and the
// tailnet is the access control.

import { createServer } from 'node:http'
import { createReadStream, promises as fs } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'

const root = resolve(process.argv[2] ?? 'dist')
const port = Number(process.argv[3] ?? process.env.PORT ?? 8742)
const host = process.env.HOST ?? '127.0.0.1'
const SYNC_DB = process.env.SYNC_DB
const SYNC_UPSTREAM = process.env.SYNC_UPSTREAM?.replace(/\/$/, '')
const MAX_BODY = 25 * 1024 * 1024

let sync = null
let labeler = null
if (SYNC_DB) {
  const { DatabaseSync } = await import('node:sqlite')
  const { SyncServer } = await import('./sync-server.mjs')
  await fs.mkdir(dirname(SYNC_DB), { recursive: true })
  sync = new SyncServer(new DatabaseSync(SYNC_DB))
  scheduleBackups(join(dirname(SYNC_DB), 'backups'))
  labeler = await startLabeler(process.env.RELATIONS_KEY_FILE ?? join(dirname(SYNC_DB), '..', 'anthropic-api-key'))
}

async function startLabeler(keyFile) {
  const apiKey = (await fs.readFile(keyFile, 'utf8').catch(() => '')).trim()
  if (!apiKey) {
    console.log(`Link labels: no API key at ${keyFile}; devices use their own guesses`)
    return null
  }
  const { RelationLabeler, claudeClassifier } = await import('./relations-ai.mjs')
  const model = process.env.RELATIONS_MODEL ?? 'claude-haiku-4-5-20251001'
  console.log(`Link labels: ${model}`)
  return new RelationLabeler(sync, claudeClassifier({ apiKey, model }), {
    model,
    maxCallsPerDay: Number(process.env.RELATIONS_MAX_CALLS_PER_DAY ?? 300),
  }).start()
}

async function scheduleBackups(dir) {
  const run = async () => {
    try {
      await fs.mkdir(dir, { recursive: true })
      const day = new Date().toISOString().slice(0, 10)
      const target = join(dir, `sync-${day}.sqlite3`)
      await fs.rm(target, { force: true })
      sync.backup(target)
      const old = (await fs.readdir(dir)).filter((f) => /^sync-.*\.sqlite3$/.test(f)).sort()
      for (const f of old.slice(0, -7)) await fs.rm(join(dir, f), { force: true })
    } catch (e) {
      console.error('Backup failed:', e)
    }
  }
  await run()
  setInterval(run, 24 * 60 * 60 * 1000).unref()
}

function json(res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(data),
  })
  res.end(data)
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > MAX_BODY) throw Object.assign(new Error('Too large'), { status: 413 })
    chunks.push(c)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** /api/sync: GET → about this server; POST → one sync round trip; GET /events → change notifications. */
async function handleSync(req, res, path) {
  if (SYNC_UPSTREAM) return proxy(req, res)
  if (!sync) return json(res, 404, { ok: false, error: 'Sync is not set up on this server' })
  if (path === '/api/sync' && req.method === 'GET') {
    return json(res, 200, {
      ok: true,
      name: process.env.SYNC_NAME ?? hostname(),
      ...sync.info(),
      relations: labeler ? labeler.stats() : null,
    })
  }
  if (path === '/api/sync' && req.method === 'POST') {
    let body
    try {
      body = JSON.parse(await readBody(req))
    } catch (e) {
      return json(res, e.status ?? 400, { ok: false, error: e.status ? e.message : 'Bad JSON' })
    }
    try {
      return json(res, 200, sync.sync(body))
    } catch (e) {
      if (e.status) return json(res, e.status, { ok: false, error: e.message })
      throw e
    }
  }
  if (path === '/api/sync/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.write(`retry: 5000\nevent: seq\ndata: ${sync.seq}\n\n`)
    const off = sync.onChange((seq) => res.write(`event: seq\ndata: ${seq}\n\n`))
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000)
    req.on('close', () => {
      off()
      clearInterval(ping)
    })
    return
  }
  json(res, 405, { ok: false, error: 'Not allowed' })
}

/** Pass a sync request through to SYNC_UPSTREAM (streaming, so events work too). */
async function proxy(req, res) {
  const abort = new AbortController()
  res.on('close', () => abort.abort())
  // Event streams stay open; plain requests give up after 30 s.
  const timer = req.url.includes('/events') ? null : setTimeout(() => abort.abort(), 30_000)
  try {
    const up = await fetch(SYNC_UPSTREAM + req.url, {
      method: req.method,
      headers: { 'Content-Type': req.headers['content-type'] ?? 'application/json', Accept: req.headers.accept ?? '*/*' },
      body: req.method === 'POST' ? await readBody(req) : undefined,
      signal: abort.signal,
    })
    const headers = { 'Cache-Control': 'no-store', 'Content-Type': up.headers.get('content-type') ?? 'application/json' }
    if (headers['Content-Type'].startsWith('text/event-stream')) headers['X-Accel-Buffering'] = 'no'
    res.writeHead(up.status, headers)
    if (!up.body) return res.end()
    const stream = Readable.fromWeb(up.body)
    stream.on('error', () => res.end())
    stream.on('end', () => clearTimeout(timer))
    stream.pipe(res)
  } catch {
    clearTimeout(timer)
    if (!res.headersSent) json(res, 502, { ok: false, error: 'Sync server unreachable' })
    else res.end()
  }
}

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
    let path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
    if (path === '/api/sync' || path.startsWith('/api/sync/')) return await handleSync(req, res, path)
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end()
      return
    }
    // Resolve the root on every request: it is a symlink swapped on deploy.
    const base = await fs.realpath(root)
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

server.listen(port, host, () => {
  const mode = sync ? `, sync at ${SYNC_DB}` : SYNC_UPSTREAM ? `, sync via ${SYNC_UPSTREAM}` : ''
  console.log(`Serving ${root} on http://${host}:${port}${mode}`)
})
