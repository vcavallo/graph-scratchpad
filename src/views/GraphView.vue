<script setup lang="ts">
// Interactive, read-only neighborhood graph. Drag nodes (the layout is a live
// force simulation); tap a node to make it the focus, which loads its own
// neighborhood around it. The focus card opens the node's page.
// d3 owns the SVG contents; Vue owns the chrome around it.

import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type ForceLink,
  type Simulation,
  type SimulationNodeDatum,
} from 'd3-force'
import { select, type Selection } from 'd3-selection'
import { drag } from 'd3-drag'
import { zoom, zoomIdentity, type ZoomBehavior } from 'd3-zoom'
import 'd3-transition'
import Icon from '@/components/Icon.vue'
import KindIcon from '@/components/KindIcon.vue'
import { api } from '@/db/api'
import type { GraphNode, Kind, Neighborhood } from '@/db/types'
import { KIND_NAMES, singular } from '@/lib/kinds'
import { categoryById } from '@/state/categories'
import { reportError } from '@/state/ui'

const props = defineProps<{ id: string }>()
const route = useRoute()
const router = useRouter()

interface SimNode extends SimulationNodeDatum, GraphNode {
  x: number
  y: number
  r: number
  text: string
  /**
   * In a crowded graph, a bullet two or more steps out: its label gives way
   * where it would cover a nearer one, and shows again as you zoom in.
   */
  minor: boolean
  /** Position in a numbered list (0-based), or null for free-floating nodes. */
  order: number | null
}
interface SimEdge {
  key: string
  source: SimNode
  target: SimNode
  type: 'child' | 'link'
  /** Position under a numbered parent. (Not `index`: d3's link force overwrites that.) */
  slot?: number
  /** For links: what the link means ("buy at"), shown on the line. */
  phrase?: string | null
}

// Numbered children hang off their parent in a column, like an outline.
const SLOT_DX = 64
const SLOT_DY0 = 40
const SLOT_GAP = 36

/**
 * Holds each numbered child in its slot beside its parent. Registered last and
 * it replaces (not adds to) the child's velocity, so link pulls and repulsion
 * can't reorder the column; the parent still moves freely and the column follows.
 * Column items hardly collide (so they can slide into order), so this also
 * nudges other nodes out of each column's box, labels included.
 */
function forceOrdered(strength = 0.35) {
  let edges: SimEdge[] = []
  let nodes: SimNode[] = []
  const fixed = (n: SimNode) => n.fx !== undefined && n.fx !== null
  const force = () => {
    const boxes = new Map<SimNode, { l: number; r: number; t: number; b: number }>()
    for (const e of edges) {
      if (e.slot === undefined) continue
      const p = e.source
      const c = e.target
      const slotY = p.y + SLOT_DY0 + e.slot * SLOT_GAP
      const box = boxes.get(p) ?? { l: p.x + SLOT_DX - 14, r: p.x + SLOT_DX, t: slotY - 16, b: slotY + 16 }
      box.r = Math.max(box.r, p.x + SLOT_DX + c.r + 10 + c.text.length * CHAR_W)
      box.t = Math.min(box.t, slotY - 16)
      box.b = Math.max(box.b, slotY + 16)
      boxes.set(p, box)
      if (fixed(c)) continue // being dragged
      c.vx = (p.x + SLOT_DX - c.x) * strength
      c.vy = (slotY - c.y) * strength
    }
    if (!boxes.size) return
    for (const n of nodes) {
      if (n.order !== null) continue
      const hw = Math.max(n.r, (n.text.length * CHAR_W) / 2) + 4
      for (const [p, box] of boxes) {
        if (p === n) continue
        const ox = Math.min(n.x + hw, box.r) - Math.max(n.x - hw, box.l)
        const oy = Math.min(n.y + n.r + 20, box.b) - Math.max(n.y - n.r, box.t)
        if (ox <= 0 || oy <= 0) continue
        const horizontal = ox < oy
        const sign = horizontal ? (n.x < (box.l + box.r) / 2 ? -1 : 1) : n.y < (box.t + box.b) / 2 ? -1 : 1
        // Move the node out of the column, or if it's pinned (the focus, or being dragged), move the column away.
        const [who, dir] = fixed(n) ? (fixed(p) ? [null, 0] : [p, -sign]) : [n, sign]
        if (!who) continue
        if (horizontal) who.vx = (who.vx ?? 0) + dir * ox * 0.3
        else who.vy = (who.vy ?? 0) + dir * oy * 0.3
      }
    }
  }
  force.links = (l: SimEdge[]) => {
    edges = l
    return force
  }
  force.initialize = (n: SimNode[]) => {
    nodes = n
  }
  return force
}
const ordered = forceOrdered()

const RADIUS: Record<Kind, number> = { pad: 13, item: 8, place: 12, person: 12, relation: 10, category: 12 }
const CHAR_W = 6.8

const hops = ref(2)
const focusId = ref((route.query.focus as string) || props.id)
const data = shallowRef<Neighborhood | null>(null)
const svg = ref<SVGSVGElement>()
const focus = computed(() => data.value?.nodes.find((n) => n.id === focusId.value) ?? null)

let sim: Simulation<SimNode, SimEdge> | null = null
let zoomer: ZoomBehavior<SVGSVGElement, unknown> | null = null
let gEdges: Selection<SVGGElement, unknown, null, undefined> | null = null
let gEdgeLabels: Selection<SVGGElement, unknown, null, undefined> | null = null
let busyGraph = false
let gNodes: Selection<SVGGElement, unknown, null, undefined> | null = null
const byId = new Map<string, SimNode>()
let simNodes: SimNode[] = []
let simEdges: SimEdge[] = []
let loadSeq = 0
/** How the next update should treat the camera. */
let nextLayout: 'settle' | 'refocus' = 'settle'
let lastInteraction = 0
let refitTimer: ReturnType<typeof setTimeout> | undefined

function truncate(s: string, n: number) {
  const t = s || 'Untitled'
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

async function load() {
  const my = ++loadSeq
  try {
    const d = await api.getNeighborhood(focusId.value, hops.value, 150)
    if (my !== loadSeq) return
    data.value = d
    update(d)
  } catch (e) {
    reportError(e)
  }
}

/** Merge a new neighborhood into the running simulation, keeping positions. */
function update(d: Neighborhood) {
  const busy = d.nodes.length > 18
  const anchor = byId.get(d.center)
  const fresh = new Set<string>()
  const orderOf = new Map<string, number>()
  for (const e of d.edges) if (e.index !== undefined) orderOf.set(e.dst, e.index)
  const next: SimNode[] = d.nodes.map((n) => {
    const major = n.id === d.center || n.kind !== 'item' || n.hop <= 1
    const existing = byId.get(n.id)
    if (!existing) fresh.add(n.id)
    const node: SimNode = existing ?? {
      ...n,
      x: (anchor?.x ?? 0) + (Math.random() - 0.5) * 120,
      y: (anchor?.y ?? 0) + (Math.random() - 0.5) * 120,
      r: 0,
      text: '',
      minor: false,
      order: null,
    }
    Object.assign(node, n)
    node.order = orderOf.get(n.id) ?? null
    // Contexts (places, people, rooms…) are drawn alike, whatever their node kind.
    const base = n.tone != null ? RADIUS.place : RADIUS[n.kind]
    node.r = n.id === d.center ? base + 5 : node.order !== null ? 10 : base
    // Every bullet has a label. Numbered ones always show it (the order is the point).
    node.text = truncate(n.label, n.id === d.center ? 26 : 22)
    node.minor = busy && !major && node.order === null
    // The focus stays put; everything else is free (unless being dragged).
    if (n.id === d.center) {
      node.fx = node.x
      node.fy = node.y
    } else if (node.fx !== undefined && node.fx !== null && !dragging.has(node.id)) {
      node.fx = null
      node.fy = null
    }
    return node
  })
  byId.clear()
  for (const n of next) byId.set(n.id, n)
  simNodes = next
  simEdges = d.edges
    .filter((e) => byId.has(e.src) && byId.has(e.dst))
    .map((e) => ({
      key: `${e.type}:${e.src}:${e.dst}`,
      source: byId.get(e.src)!,
      target: byId.get(e.dst)!,
      type: e.type,
      slot: e.index,
      phrase: e.phrase,
    }))
  busyGraph = busy
  // New numbered items start in their slots, so the column forms already in order.
  for (const e of simEdges) {
    if (e.slot === undefined || !fresh.has(e.target.id)) continue
    e.target.x = e.source.x + SLOT_DX
    e.target.y = e.source.y + SLOT_DY0 + e.slot * SLOT_GAP
  }

  sim!.nodes(simNodes)
  ;(sim!.force('link') as ForceLink<SimNode, SimEdge>).links(simEdges)
  ordered.links(simEdges)
  render()
  clearTimeout(refitTimer)
  if (nextLayout === 'settle') {
    // First open or a new distance: show a settled layout that fits.
    sim!.alpha(1).tick(300)
    sim!.alpha(0)
    ticked()
    fit(lastInteraction > 0)
  } else {
    sim!.alpha(0.7).restart()
    centerOn(byId.get(d.center))
    // If the new neighborhood spills off screen, fit once it has settled,
    // unless the user has started panning or dragging in the meantime.
    const started = Date.now()
    refitTimer = setTimeout(() => {
      if (lastInteraction < started && !allVisible()) fit()
    }, 1100)
  }
  nextLayout = 'refocus'
}

function allVisible(): boolean {
  const el = svg.value
  if (!el) return true
  const box = el.getBoundingClientRect()
  const card = el.parentElement?.querySelector<HTMLElement>('.focus-card')
  const limit = card ? card.getBoundingClientRect().top : box.bottom
  return Array.from(el.querySelectorAll('.gnode .disc')).every((c) => {
    const r = c.getBoundingClientRect()
    return r.left >= box.left && r.right <= box.right && r.top >= box.top && r.bottom <= limit
  })
}

function render() {
  if (!gEdges || !gNodes) return
  gEdges
    .selectAll<SVGLineElement, SimEdge>('line')
    .data(simEdges, (e) => e.key)
    .join('line')
    .attr('class', (e) => (e.type === 'link' ? 'edge-link' : 'edge-child'))
    .attr('marker-end', (e) => (e.type === 'link' ? 'url(#arrow)' : null))
  // Say what each link means; in a crowded graph, only for the focus's own links.
  gEdgeLabels
    ?.selectAll<SVGTextElement, SimEdge>('text')
    .data(
      simEdges.filter(
        (e) => e.phrase && (!busyGraph || e.source.id === focusId.value || e.target.id === focusId.value),
      ),
      (e) => e.key,
    )
    .join('text')
    .attr('class', 'edge-label')
    .text((e) => e.phrase!)

  const nodes = gNodes
    .selectAll<SVGGElement, SimNode>('g.gnode')
    .data(simNodes, (n) => n.id)
    .join((enter) => {
      const g = enter.append('g').attr('role', 'button')
      g.append('circle').attr('class', 'hit')
      // A rect so to-dos can be drawn as boxes (small corner radius) and everything else as discs.
      g.append('rect').attr('class', 'disc')
      g.append('path').attr('class', 'tick')
      g.append('text').attr('class', 'num').attr('text-anchor', 'middle').attr('dy', '0.35em')
      g.append('text').attr('class', 'label')
      return g
    })
  nodes
    .attr(
      'class',
      (n) =>
        `gnode kind-${n.kind}${n.tone != null ? ` tone-${n.tone}` : ''}${n.id === focusId.value ? ' center' : ''}${n.task ? ' task' : ''}${n.done ? ' done' : ''}${n.order !== null ? ' ordered' : ''}`,
    )
    .attr('aria-label', (n) => n.label || 'Untitled')
  nodes.select('circle.hit').attr('r', (n) => n.r + 12)
  nodes
    .select('rect.disc')
    .attr('x', (n) => -n.r)
    .attr('y', (n) => -n.r)
    .attr('width', (n) => 2 * n.r)
    .attr('height', (n) => 2 * n.r)
    .attr('rx', (n) => (n.task ? Math.max(3, n.r * 0.3) : n.r))
  const numbered = (n: SimNode) => n.order !== null && n.id !== focusId.value
  // Finished to-dos get a tick, unless the box already shows its number.
  nodes
    .select('path.tick')
    .attr('d', (n) =>
      n.task && n.done && !numbered(n)
        ? `M${-n.r * 0.5} ${n.r * 0.05}l${n.r * 0.35} ${n.r * 0.35}l${n.r * 0.65} ${-n.r * 0.7}`
        : null,
    )
  nodes.select('text.num').text((n) => (numbered(n) ? String(n.order! + 1) : ''))
  // Numbered items read like an outline: label to the right. Others: label below.
  // (Offsets in em: labels keep their size on screen as you zoom; see setLabelScale.)
  nodes
    .select('text.label')
    .attr('text-anchor', (n) => (n.order !== null && n.id !== focusId.value ? 'start' : 'middle'))
    // A few units clear of the rim (they grow with the outline as you zoom), then the label's own spacing.
    .attr('x', (n) => (n.order !== null && n.id !== focusId.value ? n.r + 2 : 0))
    .attr('dx', (n) => (n.order !== null && n.id !== focusId.value ? '0.35em' : null))
    .attr('y', (n) => (n.order !== null && n.id !== focusId.value ? 0 : n.r + 3))
    .attr('dy', (n) => (n.order !== null && n.id !== focusId.value ? '0.35em' : '1.05em'))
    .text((n) => n.text)
  nodes.call(dragBehavior)
  nodes.on('click', (_ev, n) => setFocus(n.id))
}

/** Edge endpoints pulled back to the node rims, so arrowheads show. */
function ticked() {
  if (!gEdges || !gNodes) return
  gEdges.selectAll<SVGLineElement, SimEdge>('line').each(function (e) {
    const dx = e.target.x - e.source.x
    const dy = e.target.y - e.source.y
    const len = Math.hypot(dx, dy) || 1
    const ux = dx / len
    const uy = dy / len
    const pad = e.type === 'link' ? 4 : 0
    this.setAttribute('x1', String(e.source.x + ux * e.source.r))
    this.setAttribute('y1', String(e.source.y + uy * e.source.r))
    this.setAttribute('x2', String(e.target.x - ux * (e.target.r + pad)))
    this.setAttribute('y2', String(e.target.y - uy * (e.target.r + pad)))
  })
  gEdgeLabels
    ?.selectAll<SVGTextElement, SimEdge>('text')
    .attr('x', (e) => (e.source.x + e.target.x) / 2)
    .attr('y', (e) => (e.source.y + e.target.y) / 2)
    .attr('dy', '-0.3em')
  gNodes.selectAll<SVGGElement, SimNode>('g.gnode').attr('transform', (n) => `translate(${n.x},${n.y})`)
  scheduleDeclutter()
}

/**
 * Labels keep about the same size on screen as you zoom: they shrink a little
 * when zoomed out to fit (to three quarters), and don't grow when zoomed in, so
 * zooming in makes room between them for the far ones.
 */
function setLabelScale(k: number) {
  const onScreen = Math.min(1, Math.max(0.75, k))
  svg.value?.style.setProperty('--label-k', String(onScreen / k))
}

let declutterTimer: ReturnType<typeof setTimeout> | undefined
let lastDeclutter = 0

/** Declutter soon, at most every 120 ms (it measures every label). */
function scheduleDeclutter() {
  if (declutterTimer) return
  const wait = Math.max(0, 120 - (performance.now() - lastDeclutter))
  declutterTimer = setTimeout(() => {
    declutterTimer = undefined
    lastDeclutter = performance.now()
    declutter()
  }, wait)
}

/** Far labels give way where they'd cover a nearer one, or a bullet; the rest always show. */
function declutter() {
  if (!gNodes) return
  const labels: { n: SimNode; el: SVGTextElement }[] = []
  const shown: DOMRect[] = []
  gNodes.selectAll<SVGGElement, SimNode>('g.gnode').each(function (n) {
    const el = this.querySelector<SVGTextElement>('text.label')
    if (el && n.text) labels.push({ n, el })
    const disc = this.querySelector('rect.disc')
    if (disc) shown.push(disc.getBoundingClientRect())
  })
  const rank = (n: SimNode) => (n.id === focusId.value ? 0 : n.minor ? 2 + n.hop : 1)
  labels.sort((a, b) => rank(a.n) - rank(b.n))
  const covers = (a: DOMRect, b: DOMRect) =>
    a.left < b.right + 2 && b.left < a.right + 2 && a.top < b.bottom + 1 && b.top < a.bottom + 1
  for (const { n, el } of labels) {
    const box = el.getBoundingClientRect()
    const hide = n.minor && shown.some((s) => covers(s, box))
    el.classList.toggle('label-hidden', hide)
    if (!hide) shown.push(box)
  }
}

const dragging = new Set<string>()
const dragBehavior = drag<SVGGElement, SimNode>()
  .clickDistance(8)
  .on('start', (ev, n) => {
    lastInteraction = Date.now()
    if (!ev.active) sim?.alphaTarget(0.25).restart()
    dragging.add(n.id)
    n.fx = n.x
    n.fy = n.y
  })
  .on('drag', (ev, n) => {
    n.fx = ev.x
    n.fy = ev.y
  })
  .on('end', (ev, n) => {
    if (!ev.active) sim?.alphaTarget(0)
    dragging.delete(n.id)
    // The focus stays where you put it; other nodes rejoin the flow.
    if (n.id !== focusId.value) {
      n.fx = null
      n.fy = null
    }
  })

function setFocus(id: string) {
  if (id === focusId.value) return
  void router.push({ query: { ...route.query, focus: id } })
}

watch(
  () => route.query.focus,
  (f) => {
    const id = (f as string) || props.id
    if (id === focusId.value) return
    focusId.value = id
    void load()
  },
)

watch(hops, () => {
  nextLayout = 'settle'
  void load()
})

function centerOn(n: SimNode | undefined) {
  const el = svg.value
  if (!el || !zoomer || !n) return
  // Centre in the area above the focus card.
  const card = el.parentElement?.querySelector<HTMLElement>('.focus-card')
  const visibleH = el.clientHeight - (card?.offsetHeight ?? 0) - 24
  select(el)
    .transition()
    .duration(450)
    .call(zoomer.translateTo, n.x, n.y, [el.clientWidth / 2, Math.max(60, visibleH / 2)])
}

function fit(animate = true) {
  const el = svg.value
  if (!el || !zoomer || simNodes.length === 0) return
  // Keep clear of the fit button (top) and the focus card (bottom).
  const card = el.parentElement?.querySelector<HTMLElement>('.focus-card')
  const top = 56
  const bottom = (card?.offsetHeight ?? 0) + 24
  const w = el.clientWidth
  const h = Math.max(120, el.clientHeight - top - bottom)
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of simNodes) {
    const labelW = (n.minor ? 0 : n.text.length) * CHAR_W
    // Column items carry their label to the right; others centre it below.
    const right = n.order !== null && n.id !== focusId.value
    minX = Math.min(minX, n.x - (right ? n.r : Math.max(n.r, labelW / 2)) - 8)
    maxX = Math.max(maxX, n.x + (right ? n.r + 6 + labelW : Math.max(n.r, labelW / 2)) + 8)
    minY = Math.min(minY, n.y - n.r - 12)
    maxY = Math.max(maxY, n.y + n.r + 28)
  }
  const k = Math.min(1.6, w / (maxX - minX), h / (maxY - minY))
  const t = zoomIdentity
    .translate(w / 2, top + h / 2)
    .scale(k)
    .translate(-(minX + maxX) / 2, -(minY + maxY) / 2)
  const s = select(el)
  if (animate) s.transition().duration(400).call(zoomer.transform, t)
  else s.call(zoomer.transform, t)
}

function openFocus() {
  void router.push(`/n/${focusId.value}`)
}

onMounted(() => {
  const el = svg.value!
  const root = select(el).append('g').attr('class', 'graph-root')
  gEdges = root.append('g').attr('class', 'edges')
  gEdgeLabels = root.append('g').attr('class', 'edge-labels')
  gNodes = root.append('g').attr('class', 'nodes')
  zoomer = zoom<SVGSVGElement, unknown>()
    .scaleExtent([0.2, 5])
    .on('zoom', (ev) => {
      root.attr('transform', ev.transform.toString())
      setLabelScale(ev.transform.k)
      scheduleDeclutter()
      // Programmatic moves (fit, centre) have no source event.
      if (ev.sourceEvent) lastInteraction = Date.now()
    })
  select(el).call(zoomer).on('dblclick.zoom', null)
  sim = forceSimulation<SimNode>([])
    .force(
      'link',
      forceLink<SimNode, SimEdge>([])
        .distance((e) => (e.type === 'child' ? 60 : 120))
        // Numbered children are placed by the ordered force instead.
        .strength((e) => (e.slot !== undefined ? 0.02 : e.type === 'child' ? 0.8 : 0.4)),
    )
    // Column items barely repel or collide, so they can slide past each other into order.
    .force('charge', forceManyBody<SimNode>().strength((n) => (n.order !== null ? -30 : -340)).distanceMax(500))
    .force(
      'collide',
      forceCollide<SimNode>((n) =>
        n.order !== null ? n.r + 1 : n.r + 10 + ((n.minor ? 0 : n.text.length) * CHAR_W) / 3,
      ).iterations(2),
    )
    // Phones are portrait: pull harder sideways than vertically.
    .force('x', forceX<SimNode>(0).strength(0.06))
    .force('y', forceY<SimNode>(0).strength(0.02))
    .force('ordered', ordered)
    .alphaDecay(0.035)
    .on('tick', ticked)
  sim.stop()
  void load()
})

onBeforeUnmount(() => {
  clearTimeout(refitTimer)
  clearTimeout(declutterTimer)
  sim?.stop()
  if (svg.value) select(svg.value).on('.zoom', null)
})
</script>

<template>
  <div class="page graph-page">
    <header class="topbar">
      <RouterLink class="back" :to="`/n/${id}`">
        <Icon name="chevron-left" />
        <span class="back-label">Back</span>
      </RouterLink>
      <span class="spacer" />
      <div class="segmented" role="radiogroup" aria-label="Distance">
        <button
          v-for="h in [1, 2, 3]"
          :key="h"
          type="button"
          role="radio"
          :aria-checked="hops === h"
          :class="{ on: hops === h }"
          @click="hops = h"
        >
          {{ h }} {{ h === 1 ? 'step' : 'steps' }}
        </button>
      </div>
    </header>
    <div class="graph-wrap">
      <svg ref="svg" class="graph" role="img" aria-label="Graph of connected items">
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0L10 5L0 10z" class="arrowhead" />
          </marker>
        </defs>
      </svg>
      <button type="button" class="icon-btn graph-fit" aria-label="Fit to screen" @click="fit()">
        <Icon name="fit" />
      </button>
      <div v-if="focus" class="focus-card" :class="`kind-${focus.kind}`">
        <KindIcon :kind="focus.kind" :category="focus.category" />
        <div class="focus-text">
          <span class="focus-label">{{ focus.label || 'Untitled' }}</span>
          <span class="focus-meta">
            {{
              categoryById(focus.category)
                ? singular(categoryById(focus.category)!.name)
                : focus.kind === 'item'
                  ? focus.task
                    ? focus.done
                      ? 'Done'
                      : 'To-do'
                    : 'Note'
                  : KIND_NAMES[focus.kind]
            }},
            {{ data!.nodes.length - 1 }} nearby{{ data?.truncated ? ' (nearest 150)' : '' }}
          </span>
        </div>
        <button type="button" class="btn btn-small btn-primary" @click="openFocus">Open</button>
      </div>
    </div>
    <div class="graph-legend">
      <span><svg width="28" height="8"><line x1="0" y1="4" x2="28" y2="4" class="edge-child" /></svg> Nested</span>
      <span><svg width="28" height="8"><line x1="0" y1="4" x2="28" y2="4" class="edge-link" /></svg> Link</span>
      <span class="legend-node"><svg width="14" height="14"><rect x="1.5" y="1.5" width="11" height="11" rx="2.5" /></svg> To-do</span>
      <span class="legend-node"><svg width="14" height="14"><circle cx="7" cy="7" r="5.5" /></svg> Note</span>
      <span class="legend-hint">Tap to focus, drag to move</span>
    </div>
  </div>
</template>
