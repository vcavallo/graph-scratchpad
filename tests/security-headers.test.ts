// The follow-up Content-Security-Policy needs a hash for the inline theme
// bootstrap script in index.html. Pin it here so a change to that script
// cannot silently break the CSP documented in the headers commit.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('inline theme script hash (for a future CSP)', () => {
  it('matches the pinned sha256', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
    const m = /<script>\n([\s\S]*?)\n\s*<\/script>/.exec(html)
    expect(m).toBeTruthy()
    const b64 = createHash('sha256').update(m![1] + '\n').digest('base64')
    expect(b64).toBe('IqEy136d2dPh4jWyypLkxlh213ixncgxF13P6AM3Ugg=')
  })
})
