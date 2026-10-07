// Copying lines to the clipboard, for pasting into other apps: one line as
// text, or a line with everything under it (or a whole page) as a markdown
// list, with an HTML version for apps that paste rich text.

import { api } from '@/db/api'
import type { TreeNode } from '@/db/types'
import { mergeRefs, refCache } from '@/state/refs'
import { reportError, toast } from '@/state/ui'
import { escapeHtml, lineCount, lineText, linkedIds, toHtml, toMarkdown } from './markdownOut'

interface Copied {
  text: string
  html?: string
}

const nameOf = (id: string) => refCache[id]?.label

/** Names for every link in the lines, including ones folded away and never drawn. */
async function loadNames(lines: TreeNode[]): Promise<void> {
  const ids = linkedIds(lines).filter((id) => !refCache[id])
  if (ids.length) mergeRefs(await api.getRefs(ids))
}

/**
 * Put text on the clipboard. Call it straight from a tap (browsers only allow
 * copying then): what's copied may still be on its way (names to look up), so
 * the clipboard is handed a promise where it can take one.
 */
async function write(copied: Promise<Copied>): Promise<void> {
  const clip = navigator.clipboard
  if (clip?.write && typeof ClipboardItem !== 'undefined') {
    try {
      await clip.write([
        new ClipboardItem({
          'text/plain': copied.then((c) => new Blob([c.text], { type: 'text/plain' })),
          'text/html': copied.then((c) => new Blob([c.html ?? ''], { type: 'text/html' })),
        }),
      ])
      return
    } catch {
      // Older browsers take only text; try that.
    }
  }
  const { text } = await copied
  try {
    await clip.writeText(text)
  } catch {
    // Last resort, for browsers without the clipboard API (or outside HTTPS).
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0'
    document.body.append(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    if (!ok) throw new Error('This browser didn’t allow copying')
  }
}

function copy(copied: Promise<Copied>, done: string): void {
  write(copied).then(
    () => toast(done),
    (e) => reportError(e),
  )
}

/** The line's text, links as names. */
export function copyLine(n: TreeNode): void {
  copy(
    loadNames([{ ...n, children: [] }]).then(() => {
      const text = lineText(n.text, nameOf)
      return { text, html: escapeHtml(text) }
    }),
    'Copied the line',
  )
}

/** The line and everything under it, as a markdown list. */
export function copyWithChildren(n: TreeNode): void {
  copy(
    loadNames([n]).then(() => ({ text: toMarkdown([n], nameOf) + '\n', html: toHtml([n], nameOf) })),
    `Copied ${lineCount([n])} lines as markdown`,
  )
}

/** A page as a markdown list; a pad's title becomes a heading over its lines. */
export function copyPage(tree: TreeNode, asHeading: boolean, shownAs: string): void {
  if (!asHeading) return copyWithChildren(tree)
  copy(
    loadNames([tree]).then(() => {
      const heading = lineText(tree.text, nameOf) || 'Untitled'
      const list = toMarkdown(tree.children, nameOf, tree.numbered)
      return {
        text: `# ${heading}\n${list ? `\n${list}\n` : ''}`,
        html: `<h1>${escapeHtml(heading)}</h1>${toHtml(tree.children, nameOf, tree.numbered)}`,
      }
    }),
    `Copied “${shownAs}” as markdown`,
  )
}
