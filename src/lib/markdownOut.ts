// Lines out to other apps: a line's text, or lines with everything under them
// as a markdown list (the reverse of pasteLines), links written as the names of
// what they point at. Also as HTML lists, for apps that paste rich text.

import type { TreeNode } from '@/db/types'
import { labelize, parseTokens } from './tokens'

/** The name a link should be written as, by the id it points at. */
export type LinkName = (id: string) => string | undefined

/** A line's text, its links written as what they point at. */
export function lineText(text: string, name: LinkName): string {
  return labelize(text, name).trim()
}

/** Every node the lines (and the lines under them) link to. */
export function linkedIds(lines: TreeNode[]): string[] {
  const ids = new Set<string>()
  const walk = (n: TreeNode) => {
    for (const id of parseTokens(n.text)) ids.add(id)
    n.children.forEach(walk)
  }
  lines.forEach(walk)
  return [...ids]
}

/** How many lines, counting the ones under them. */
export function lineCount(lines: TreeNode[]): number {
  return lines.reduce((sum, n) => sum + 1 + lineCount(n.children), 0)
}

/**
 * The lines as a markdown list: "- " for each, "1. " when they're numbered,
 * "[ ]" or "[x]" for to-dos, and the lines under each indented to its text.
 * Pasting it back in (pasteLines) gives the same outline.
 */
export function toMarkdown(lines: TreeNode[], name: LinkName, numbered = false): string {
  const out: string[] = []
  const walk = (nodes: TreeNode[], indent: string, numbered: boolean) => {
    nodes.forEach((n, i) => {
      const marker = numbered ? `${i + 1}. ` : '- '
      const box = n.task ? (n.done ? '[x] ' : '[ ] ') : ''
      out.push(`${indent}${marker}${box}${lineText(n.text, name)}`.trimEnd())
      walk(n.children, indent + ' '.repeat(marker.length), n.numbered)
    })
  }
  walk(lines, '', numbered)
  return out.join('\n')
}

export const escapeHtml = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

/** The same lines as nested HTML lists, to-dos marked ☐ and ☑. */
export function toHtml(lines: TreeNode[], name: LinkName, numbered = false): string {
  const list = (nodes: TreeNode[], numbered: boolean): string => {
    if (!nodes.length) return ''
    const tag = numbered ? 'ol' : 'ul'
    const items = nodes.map((n) => {
      const box = n.task ? (n.done ? '☑ ' : '☐ ') : ''
      return `<li>${box}${escapeHtml(lineText(n.text, name))}${list(n.children, n.numbered)}</li>`
    })
    return `<${tag}>${items.join('')}</${tag}>`
  }
  return list(lines, numbered)
}
