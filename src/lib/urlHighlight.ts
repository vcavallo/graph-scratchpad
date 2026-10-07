// Web addresses in editors, underlined with a CSS highlight (::highlight(gp-url)
// in main.css) so the editor's DOM stays plain text and chips. One highlight
// for every editor; null where the browser has no CSS highlights.

let shared: Highlight | null | undefined

export function urlHighlight(): Highlight | null {
  if (shared === undefined) {
    shared = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined' ? new Highlight() : null
    if (shared) CSS.highlights.set('gp-url', shared)
  }
  return shared
}
