<script setup lang="ts">
// One line of editable text with link chips. The DOM inside the
// contenteditable is managed by hand (not by Vue) so typing is never clobbered
// by a re-render; it is rebuilt from `text` only when the editor isn't focused
// or the change came from outside.

import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  caretOnEdgeLine,
  getCaret,
  pasteLines,
  renderEditor,
  serialize,
  setCaret,
  updateChips,
  ZWSP,
  type CaretTarget,
  type Shortcut,
} from '@/lib/editorDom'
import { registerEditor, unregisterEditor, noteBlur, noteFocus, type EditorHandle } from '@/state/focus'
import { refCache, refsVersion } from '@/state/refs'
import { reportError } from '@/state/ui'

const props = withDefaults(
  defineProps<{
    text: string
    editorKey: string
    save: (text: string) => Promise<unknown> | void
    placeholder?: string
    label?: string
    debounce?: number
  }>(),
  { placeholder: '', label: 'Text', debounce: 500 },
)

const emit = defineEmits<{
  enter: [parts: { before: string; after: string }]
  backspaceStart: [info: { empty: boolean }]
  tab: [shift: boolean]
  arrow: [dir: 'up' | 'down']
  shortcut: [name: Shortcut]
  atTrigger: [offset: number]
  chip: [id: string]
  pasteLines: [lines: string[]]
  focus: []
  blur: []
}>()

const el = ref<HTMLDivElement>()
const empty = ref(!props.text)
let focused = false
let composing = false
let committed = props.text
let timer: ReturnType<typeof setTimeout> | undefined
let inFlight = 0
let lastAt = -1
let revealTimer: ReturnType<typeof setTimeout> | undefined

function current(): string {
  return el.value ? serialize(el.value) : committed
}

function updateEmpty() {
  empty.value = current() === ''
}

function render(text: string) {
  if (!el.value) return
  renderEditor(el.value, text, refCache)
  updateEmpty()
}

async function flush(): Promise<void> {
  if (timer) {
    clearTimeout(timer)
    timer = undefined
  }
  const t = current()
  if (t === committed) return
  committed = t
  inFlight++
  try {
    await props.save(t)
  } catch (e) {
    reportError(e)
  } finally {
    inFlight--
  }
}

function schedule() {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = undefined
    void flush()
  }, props.debounce)
}

watch(
  () => props.text,
  (t) => {
    // Our own save is pending or in flight: this value may be stale.
    if (inFlight > 0 || timer) return
    committed = t
    if (!el.value || current() === t) return
    if (focused) {
      const c = getCaret(el.value)?.start
      render(t)
      if (c !== undefined) setCaret(el.value, Math.min(c, t.length))
    } else {
      render(t)
    }
  },
)

watch(refsVersion, () => {
  if (el.value) updateChips(el.value, refCache)
})

/** Browsers sometimes inject <div>, <span style> or <font>; rebuild if so. */
function sanitize() {
  const e = el.value
  if (!e || composing) return
  const stray = Array.from(e.children).some(
    (c) => !(c.classList.contains('chip') && (c as HTMLElement).dataset.id) && c.tagName !== 'BR',
  )
  if (!stray) return
  const c = getCaret(e)?.start
  render(current())
  if (focused && c !== undefined) setCaret(e, c)
}

function checkAt() {
  const e = el.value
  if (!e) return
  const c = getCaret(e)
  if (!c || c.start !== c.end) return
  const t = current()
  if (t[c.start - 1] !== '@') {
    lastAt = -1
    return
  }
  const prev = t[c.start - 2]
  const wordStart = c.start === 1 || /[\s([{"'“‘]/.test(prev) || t.slice(0, c.start - 1).endsWith(']]')
  if (!wordStart || lastAt === c.start) return
  lastAt = c.start
  emit('atTrigger', c.start)
}

function onInput(e: Event) {
  const ie = e as InputEvent
  sanitize()
  // Emptied by select-all + delete: put the zero-width placeholder back so
  // Android keyboards still send a Backspace we can see.
  const e2 = el.value
  if (e2 && !composing && current() === '' && e2.textContent !== ZWSP) {
    render('')
    if (focused) setCaret(e2, 0)
  }
  updateEmpty()
  schedule()
  if (!ie.isComposing && (ie.inputType ?? 'insertText').startsWith('insert')) checkAt()
}

function onCompositionStart() {
  composing = true
}

function onCompositionEnd() {
  composing = false
  sanitize()
  checkAt()
}

function doEnter() {
  const e = el.value!
  const t = current()
  const c = getCaret(e) ?? { start: t.length, end: t.length }
  emit('enter', { before: t.slice(0, c.start), after: t.slice(c.end) })
}

function caretAtStart(): boolean {
  const c = el.value ? getCaret(el.value) : null
  return !!c && c.start === 0 && c.end === 0
}

function onBeforeInput(e: InputEvent) {
  const type = e.inputType
  if (type === 'insertParagraph' || type === 'insertLineBreak') {
    e.preventDefault()
    doEnter()
  } else if (type === 'deleteContentBackward') {
    if (caretAtStart()) {
      e.preventDefault()
      emit('backspaceStart', { empty: current() === '' })
    }
  } else if (type.startsWith('format') || type === 'insertFromDrop') {
    e.preventDefault()
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.isComposing || e.keyCode === 229) return
  const mod = e.ctrlKey || e.metaKey
  switch (e.key) {
    case 'Enter':
      e.preventDefault()
      if (mod) emit('shortcut', 'toggle-done')
      else if (!e.shiftKey) doEnter()
      return
    case 'Tab':
      e.preventDefault()
      emit('tab', e.shiftKey)
      return
    case 'Backspace':
      if (!mod && !e.altKey && caretAtStart()) {
        e.preventDefault()
        emit('backspaceStart', { empty: current() === '' })
      }
      return
    case 'ArrowUp':
    case 'ArrowDown': {
      const up = e.key === 'ArrowUp'
      if ((e.altKey || mod) && e.shiftKey) {
        e.preventDefault()
        emit('shortcut', up ? 'move-up' : 'move-down')
      } else if (mod) {
        e.preventDefault()
        emit('shortcut', up ? 'collapse' : 'expand')
      } else if (!e.shiftKey && !e.altKey && caretOnEdgeLine(el.value!, up ? 'first' : 'last')) {
        e.preventDefault()
        emit('arrow', up ? 'up' : 'down')
      }
      return
    }
    case 'Escape':
      el.value?.blur()
      return
  }
  if (mod && ['b', 'i', 'u'].includes(e.key.toLowerCase())) e.preventDefault()
}

function insertText(s: string) {
  // execCommand keeps the browser's undo stack intact and fires `input`.
  if (!document.execCommand('insertText', false, s)) {
    const e = el.value!
    const t = current()
    const c = getCaret(e) ?? { start: t.length, end: t.length }
    render(t.slice(0, c.start) + s + t.slice(c.end))
    setCaret(e, c.start + s.length)
    schedule()
  }
}

function onPaste(e: ClipboardEvent) {
  e.preventDefault()
  const text = e.clipboardData?.getData('text/plain') ?? ''
  if (!text) return
  if (!/[\r\n]/.test(text.trim())) {
    insertText(text.trim())
    return
  }
  const lines = pasteLines(text)
  if (lines.length === 0) return
  insertText(lines[0])
  if (lines.length > 1) emit('pasteLines', lines.slice(1))
}

function onClick(e: MouseEvent) {
  const chip = (e.target as HTMLElement).closest?.('.chip[data-id]') as HTMLElement | null
  if (chip) {
    e.preventDefault()
    emit('chip', chip.dataset.id!)
  }
}

/** Keep the caret clear of the keyboard toolbar once the keyboard has opened. */
function revealSoon() {
  clearTimeout(revealTimer)
  revealTimer = setTimeout(() => {
    const e = el.value
    if (!e || !focused) return
    const vv = window.visualViewport
    const viewBottom = vv ? vv.offsetTop + vv.height : window.innerHeight
    const toolbar = document.querySelector('.edit-toolbar') as HTMLElement | null
    const limit = viewBottom - (toolbar?.offsetHeight ?? 0) - 12
    const r = e.getBoundingClientRect()
    if (r.bottom > limit) window.scrollBy({ top: r.bottom - limit, behavior: 'smooth' })
    else if (r.top < 56) window.scrollBy({ top: r.top - 64, behavior: 'smooth' })
  }, 320)
}

function onFocus() {
  focused = true
  noteFocus(props.editorKey)
  emit('focus')
  revealSoon()
}

function onBlur() {
  focused = false
  composing = false
  noteBlur(props.editorKey)
  sanitize()
  void flush()
  emit('blur')
}

const handle: EditorHandle = {
  focus(at: CaretTarget = 'end') {
    const e = el.value
    if (!e) return
    if (document.activeElement !== e) e.focus({ preventScroll: true })
    setCaret(e, at)
    revealSoon()
  },
  caret() {
    return el.value ? (getCaret(el.value)?.start ?? null) : null
  },
  text: current,
  replace(text, opts = {}) {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    if (opts.saved) committed = text
    render(text)
    if (opts.caret !== undefined && el.value && focused) setCaret(el.value, opts.caret)
    if (!opts.saved) schedule()
  },
  flush,
  isFocused: () => focused && document.activeElement === el.value,
  insertText,
}

defineExpose(handle)

onMounted(() => {
  render(props.text)
  registerEditor(props.editorKey, handle)
})

onBeforeUnmount(() => {
  clearTimeout(revealTimer)
  void flush()
  if (focused) noteBlur(props.editorKey)
  unregisterEditor(props.editorKey, handle)
})
</script>

<template>
  <div
    ref="el"
    class="editable"
    :class="{ 'is-empty': empty }"
    contenteditable="true"
    role="textbox"
    spellcheck="true"
    autocapitalize="sentences"
    enterkeyhint="enter"
    :aria-label="label"
    :data-placeholder="placeholder"
    @input="onInput"
    @beforeinput="onBeforeInput"
    @keydown="onKeydown"
    @compositionstart="onCompositionStart"
    @compositionend="onCompositionEnd"
    @focus="onFocus"
    @blur="onBlur"
    @paste="onPaste"
    @click="onClick"
  />
</template>
