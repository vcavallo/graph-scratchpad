// Runs every browser check against a fresh production build.
// Usage: npm run e2e   (set BASE_URL to test an already-running server)
import { spawn, execSync } from 'node:child_process'

const suites = ['edit.mjs', 'links.mjs', 'more.mjs', 'regressions.mjs', 'graph.mjs', 'todos.mjs', 'sync.mjs', 'reload.mjs']
let server
if (!process.env.BASE_URL) {
  execSync('npx vite build', { stdio: 'inherit' })
  server = spawn('npx', ['vite', 'preview', '--port', '4174', '--strictPort'], { stdio: 'ignore' })
  process.env.BASE_URL = 'http://localhost:4174'
  await new Promise((r) => setTimeout(r, 1500))
}
let failed = 0
for (const s of suites) {
  console.log(`\n# ${s}`)
  try {
    execSync(`node ${new URL(s, import.meta.url).pathname}`, { stdio: 'inherit', env: process.env })
  } catch {
    failed++
  }
}
server?.kill()
console.log(failed ? `\n${failed} suite(s) failed` : '\nAll browser checks passed')
process.exit(failed ? 1 : 0)
