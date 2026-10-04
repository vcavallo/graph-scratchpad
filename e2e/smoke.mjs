import { launch, watchConsole, shot, outline, BASE, sleep } from './lib.mjs'

const { ctx, close } = await launch()
const page = await ctx.newPage()
const errors = watchConsole(page)
await page.goto(BASE + '/')
await page.waitForSelector('.outline .row', { timeout: 15000 })
await sleep(500)
console.log(await outline(page))
console.log('url', page.url())
console.log('storage', await page.evaluate(() => document.querySelector('.banner-danger')?.textContent ?? 'ok'))
await shot(page, 'smoke-welcome')
console.log('errors:', errors)
await close()
