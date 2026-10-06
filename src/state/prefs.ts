// Small per-device preferences kept in localStorage (never data).

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // Storage can be unavailable (private mode); preferences are optional.
  }
}

export const prefs = {
  get lastPad(): string | null {
    return read('gs.lastPad')
  },
  set lastPad(v: string | null) {
    write('gs.lastPad', v)
  },
  get persistAsked(): boolean {
    return read('gs.persistAsked') === '1'
  },
  set persistAsked(v: boolean) {
    write('gs.persistAsked', v ? '1' : null)
  },
  /** The list "Send to…" last sent something to, offered first next time. */
  get lastSendTo(): { id: string; label: string } | null {
    try {
      const v = JSON.parse(read('gs.lastSendTo') ?? 'null')
      return v && typeof v.id === 'string' ? { id: v.id, label: String(v.label ?? '') } : null
    } catch {
      return null
    }
  },
  set lastSendTo(v: { id: string; label: string } | null) {
    write('gs.lastSendTo', v ? JSON.stringify(v) : null)
  },
  get showDoneBacklinks(): boolean {
    return read('gs.showDoneBacklinks') === '1'
  },
  set showDoneBacklinks(v: boolean) {
    write('gs.showDoneBacklinks', v ? '1' : null)
  },
  /** Light or dark on this device; null follows the system. (index.html reads it too, before the first paint.) */
  get theme(): 'light' | 'dark' | null {
    const v = read('gs.theme')
    return v === 'light' || v === 'dark' ? v : null
  },
  set theme(v: 'light' | 'dark' | null) {
    write('gs.theme', v)
  },
  /** Vim keys in the editor (for a computer keyboard). */
  get vim(): boolean {
    return read('gs.vim') === '1'
  },
  set vim(v: boolean) {
    write('gs.vim', v ? '1' : null)
  },
}
