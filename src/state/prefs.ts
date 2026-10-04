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
  get showDoneBacklinks(): boolean {
    return read('gs.showDoneBacklinks') === '1'
  },
  set showDoneBacklinks(v: boolean) {
    write('gs.showDoneBacklinks', v ? '1' : null)
  },
}
