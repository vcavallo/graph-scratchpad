<script setup lang="ts">
import { computed } from 'vue'

const circle = (cx: number, cy: number, r: number) =>
  `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`

const PATHS: Record<string, string> = {
  'chevron-right': 'M9 6l6 6-6 6',
  'chevron-left': 'M15 6l-6 6 6 6',
  'chevron-down': 'M6 9l6 6 6-6',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  indent: 'M3 5h18M11 12h10M11 19h10M3 9l4 3-4 3',
  outdent: 'M3 5h18M11 12h10M11 19h10M7 9l-4 3 4 3',
  'arrow-up': 'M12 19V5M6 11l6-6 6 6',
  'arrow-down': 'M12 5v14M18 13l-6 6-6-6',
  at: `${circle(12, 12, 4)}M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8`,
  check: 'M5 12.5l4.5 4.5L19 7.5',
  trash: 'M4 7h16M9 7V4h6v3M18 7l-1 13H7L6 7M10 11v5M14 11v5',
  'keyboard-hide': 'M3 4h18v11H3zM7 8h.01M11 8h.01M15 8h.01M8 11.5h8M9 19l3 2.5 3-2.5',
  list: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
  pin: `M12 21s-7-6.2-7-11.2a7 7 0 0 1 14 0C19 14.8 12 21 12 21z${circle(12, 9.8, 2.6)}`,
  person: `${circle(12, 8, 4)}M4 21a8 8 0 0 1 16 0`,
  search: `${circle(11, 11, 7)}M20.5 20.5l-4.5-4.5`,
  settings: `M4 7h9M18 7h2M4 17h3M12 17h8${circle(15.5, 7, 2.5)}${circle(9.5, 17, 2.5)}`,
  plus: 'M12 5v14M5 12h14',
  graph: `${circle(6, 6, 2.5)}${circle(18, 9, 2.5)}${circle(9, 18, 2.5)}M8.4 6.8l7.2 1.6M7 8.4l1.4 7.2M16.3 10.9l-5.4 5.4`,
  undo: 'M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
  move: 'M14 10l5 5-5 5M4 4v7a4 4 0 0 0 4 4h11',
  x: 'M6 6l12 12M18 6L6 18',
  download: 'M12 3v12M7 10l5 5 5-5M5 20h14',
  upload: 'M12 20V8M7 13l5-5 5 5M5 4h14',
  open: 'M7 17L17 7M8 7h9v9',
  share: 'M4 13v7h16v-7M12 3v12M7.5 7.5L12 3l4.5 4.5',
  pad: 'M6 3h12v18H6zM9 8h6M9 12h6M9 16h4',
  dot: circle(12, 12, 3),
  edit: 'M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4',
  collapse: 'M8 10l4-4 4 4M8 14l4 4 4-4',
  shield: 'M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6l8-3z',
  trashcan: 'M4 7h16M9 7V4h6v3M18 7l-1 13H7L6 7',
  fit: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5',
  numbered: 'M10 6h10M10 12h10M10 18h10M4 4.5h1.5V9M4 9h3M4 14.5c0-.8.7-1.5 1.5-1.5S7 13.7 7 14.5c0 1.2-3 2-3 4h3',
  checkbox: 'M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM8.5 12.5l2.5 2.5 4.5-5',
  linked: `${circle(17.5, 12, 3.5)}M3 12h9M9 8.5l3.5 3.5L9 15.5`,
  sync: 'M19.5 10A7.5 7.5 0 0 0 6 6.5L4 8.5M4 4v4.5h4.5M4.5 14A7.5 7.5 0 0 0 18 17.5l2-2M20 20v-4.5h-4.5',
  home: 'M4 11l8-7 8 7M6 9.5V20h12V9.5M10 20v-5h4v5',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z',
  tag: 'M3 12V4h8l9 9-8 8-9-9zM7.5 8h.01',
  box: 'M3 8l9-5 9 5v8l-9 5-9-5V8zM3 8l9 5 9-5M12 13v8',
  star: 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9L12 3z',
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
}

const props = withDefaults(defineProps<{ name: string; size?: number; stroke?: number }>(), { size: 22, stroke: 2 })
const d = computed(() => PATHS[props.name] ?? PATHS.dot)
</script>

<template>
  <svg
    class="icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="name === 'more' ? 3.2 : stroke"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path :d="d" />
  </svg>
</template>
