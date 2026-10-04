// Publish dist/ as a new release for the local server (scripts/serve.mjs).
// Copies into a timestamped directory, gzips text assets, then atomically
// repoints the `current` symlink. Keeps the three newest releases.
// Usage: npm run deploy   (builds first)

import { promises as fs, createReadStream, createWriteStream } from 'node:fs'
import { createGzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { join, extname } from 'node:path'
import { homedir } from 'node:os'

const DEPLOY_ROOT = process.env.DEPLOY_ROOT ?? join(homedir(), '.local/share/graph-scratchpad')
const dist = new URL('../dist/', import.meta.url).pathname
const GZIP = new Set(['.js', '.css', '.html', '.wasm', '.svg', '.json', '.webmanifest'])

async function walk(dir) {
  const out = []
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walk(p)))
    else out.push(p)
  }
  return out
}

await fs.access(join(dist, 'index.html'))
const releases = join(DEPLOY_ROOT, 'releases')
await fs.mkdir(releases, { recursive: true })
const name = new Date().toISOString().replace(/[:.]/g, '-')
const target = join(releases, name)
await fs.cp(dist, target, { recursive: true })

for (const file of await walk(target)) {
  if (!GZIP.has(extname(file))) continue
  await pipeline(createReadStream(file), createGzip({ level: 9 }), createWriteStream(file + '.gz'))
}

const current = join(DEPLOY_ROOT, 'current')
const tmp = current + '.tmp'
await fs.rm(tmp, { force: true })
await fs.symlink(target, tmp)
await fs.rename(tmp, current)

// The service runs the server from here, independent of the repo checkout.
await fs.copyFile(new URL('./serve.mjs', import.meta.url).pathname, join(DEPLOY_ROOT, 'serve.mjs'))

const all = (await fs.readdir(releases)).sort()
for (const old of all.slice(0, -3)) await fs.rm(join(releases, old), { recursive: true, force: true })

console.log(`Deployed ${name} -> ${current}`)
