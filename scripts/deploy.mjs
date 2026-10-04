// Publish a release: the built app (with .gz siblings for text assets) and the
// server that serves it. Layout under the deploy root:
//   releases/<stamp>/app/      static files (the server's root)
//   releases/<stamp>/server/   serve.mjs, sync-server.mjs
//   current -> releases/<stamp>   swapped atomically; the three newest are kept
// The server picks up new static files on the next request; it's restarted
// only when its own code changed.
//
// Usage: node scripts/deploy.mjs        this machine (~/.local/share/graph-scratchpad, user service)
//        node scripts/deploy.mjs --pi   the Pi over ssh (/var/lib/graph-scratchpad, system service
//                                       from deploy/nixos/graph-scratchpad.nix)
// Environment: DEPLOY_ROOT (local), DEPLOY_HOST and DEPLOY_REMOTE_ROOT (--pi).

import { promises as fs, createReadStream, createWriteStream } from 'node:fs'
import { createGzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { execFileSync } from 'node:child_process'
import { join, extname } from 'node:path'
import { homedir, tmpdir } from 'node:os'

const SERVICE = 'graph-scratchpad'
const GZIP = new Set(['.js', '.css', '.html', '.wasm', '.svg', '.json', '.webmanifest'])
const SERVER_FILES = ['serve.mjs', 'sync-server.mjs']
const repo = new URL('..', import.meta.url).pathname
const dist = join(repo, 'dist')
const toPi = process.argv.includes('--pi')

async function walk(dir) {
  const out = []
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walk(p)))
    else out.push(p)
  }
  return out
}

const run = (cmd, args, opts = {}) =>
  String(execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], ...opts }) ?? '')

// ---------------------------------------------------------------- stage

await fs.access(join(dist, 'index.html'))
const name = new Date().toISOString().replace(/[:.]/g, '-')
const stage = await fs.mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'gs-release-'))
await fs.cp(dist, join(stage, 'app'), { recursive: true })
for (const file of await walk(join(stage, 'app'))) {
  if (!GZIP.has(extname(file))) continue
  await pipeline(createReadStream(file), createGzip({ level: 9 }), createWriteStream(file + '.gz'))
}
await fs.mkdir(join(stage, 'server'))
for (const f of SERVER_FILES) await fs.copyFile(join(repo, 'server', f), join(stage, 'server', f))

// ---------------------------------------------------------------- publish

if (toPi) {
  const host = process.env.DEPLOY_HOST ?? 'utility-server-pi'
  const root = process.env.DEPLOY_REMOTE_ROOT ?? '/var/lib/graph-scratchpad'
  run('rsync', ['-a', '--chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r', `${stage}/`, `${host}:${root}/releases/${name}/`], {
    stdio: 'inherit',
  })
  const script = `
    set -e
    cd ${root}
    prev=$(readlink -e current || true)
    ln -sfn releases/${name} current.tmp && mv -Tf current.tmp current
    changed=1
    if [ -n "$prev" ] && ${SERVER_FILES.map((f) => `cmp -s "$prev/server/${f}" current/server/${f}`).join(' && ')}; then changed=0; fi
    ls -1 releases | head -n -3 | while read old; do rm -rf "releases/$old"; done
    systemctl is-active --quiet ${SERVICE} || changed=1
    if [ "$changed" = 1 ]; then sudo systemctl restart ${SERVICE} && echo "restarted ${SERVICE}"; fi
  `
  process.stdout.write(run('ssh', [host, script]))
  console.log(`Deployed ${name} -> ${host}:${root}/current`)
} else {
  const root = process.env.DEPLOY_ROOT ?? join(homedir(), '.local/share/graph-scratchpad')
  const releases = join(root, 'releases')
  await fs.mkdir(releases, { recursive: true })
  const current = join(root, 'current')
  const prev = await fs.realpath(current).catch(() => null)
  await fs.cp(stage, join(releases, name), { recursive: true })
  const tmp = current + '.tmp'
  await fs.rm(tmp, { force: true })
  await fs.symlink(join(releases, name), tmp)
  await fs.rename(tmp, current)
  let changed = !prev
  for (const f of SERVER_FILES) {
    const before = prev ? await fs.readFile(join(prev, 'server', f), 'utf8').catch(() => null) : null
    if (before !== (await fs.readFile(join(current, 'server', f), 'utf8'))) changed = true
  }
  const all = (await fs.readdir(releases)).sort()
  for (const old of all.slice(0, -3)) await fs.rm(join(releases, old), { recursive: true, force: true })
  if (changed) {
    try {
      run('systemctl', ['--user', 'restart', SERVICE])
      console.log(`restarted ${SERVICE}`)
    } catch {
      console.log(`(server code changed; restart ${SERVICE} yourself)`)
    }
  }
  console.log(`Deployed ${name} -> ${current}`)
}
await fs.rm(stage, { recursive: true, force: true })
