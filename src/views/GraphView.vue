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
import { KIND_NAMES } from '@/lib/kinds'
import { reportError } from '@/state/ui'

const props = defineProps<{ id: string }>()
const route = useRoute()
const router = useRouter()

interface SimNode extends SimulationNodeDatum, GraphNode {
  x: number
  y: number
  r: number
  text: string
}
interface SimEdge {
  key: string
  source: SimNode
  target: SimNode
  type: 'child' | 'link'
}

const RADIUS: Record<Kind, number> = { pad: 13, item: 8, place: 12, person: 12 }
const CHAR_W = 6.8

const hops = ref(2)
const focusId = ref((route.query.focus as string) || props.id)
const data = shallowRef<Neighborhood | null>(null)
const svg = ref<SVGSVGElement>()
const focus = computed(() => data.value?.nodes.find((n) => n.id === focusId.value) ?? null)

let sim: Simulation<SimNode, SimEdge> | null = null
let zoomer: ZoomBehavior<SVGSVGElement, unknown> | null = null
let gEdges: Selection<SVGGElement, unknown, null, undefined> | null = null
let gNodes: Selection<SVGGElement, unknown, null, undefined> | null = null
const byId = new Map<string, SimNode>()
let simNodes: SimNode[] = []
let simEdges: SimEdge[] = []
let firstLayout = true
let loadSeq = 0

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
  const next: SimNode[] = d.nodes.map((n) => {
    const major = n.id === d.center || n.kind !== 'item' || n.hop <= 1
    const existing = byId.get(n.id)
    const node: SimNode = existing ?? {
      ...n,
      x: (anchor?.x ?? 0) + (Math.random() - 0.5) * 120,
      y: (anchor?.y ?? 0) + (Math.random() - 0.5) * 120,
      r: 0,
      text: '',
    }
    Object.assign(node, n)
    node.r = n.id === d.center ? RADIUS[n.kind] + 5 : RADIUS[n.kind]
    node.text = !busy || major ? truncate(n.label, n.id === d.center ? 26 : 18) : ''
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
    .map((e) => ({ key: `${e.type}:${e.src}:${e.dst}`, source: byId.get(e.src)!, target: byId.get(e.dst)!, type: e.type }))

  sim!.nodes(simNodes)
  ;(sim!.force('link') as ForceLink<SimNode, SimEdge>).links(simEdges)
  render()
  if (firstLayout) {
    // Open on a settled layout rather than watching it unfold.
    sim!.alpha(1).tick(300)
    ticked()
    fit(false)
    firstLayout = false
    sim!.alpha(0)
  } else {
    sim!.alpha(0.7).restart()
    centerOn(byId.get(d.center))
  }
}

function render() {
  if (!gEdges || !gNodes) return
  gEdges
    .selectAll<SVGLineElement, SimEdge>('line')
    .data(simEdges, (e) => e.key)
    .join('line')
    .attr('class', (e) => (e.type === 'link' ? 'edge-link' : 'edge-child'))
    .attr('marker-end', (e) => (e.type === 'link' ? 'url(#arrow)' : null))

  const nodes = gNodes
    .selectAll<SVGGElement, SimNode>('g.gnode')
    .data(simNodes, (n) => n.id)
    .join((enter) => {
      const g = enter.append('g').attr('role', 'button')
      g.append('circle').attr('class', 'hit')
      g.append('circle').attr('class', 'disc')
      g.append('text').attr('text-anchor', 'middle')
      return g
    })
  nodes
    .attr('class', (n) => `gnode kind-${n.kind}${n.id === focusId.value ? ' center' : ''}${n.done ? ' done' : ''}`)
    .attr('aria-label', (n) => n.label || 'Untitled')
  nodes.select('circle.hit').attr('r', (n) => n.r + 12)
  nodes.select('circle.disc').attr('r', (n) => n.r)
  nodes
    .select('text')
    .attr('y', (n) => n.r + 15)
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
  gNodes.selectAll<SVGGElement, SimNode>('g.gnode').attr('transform', (n) => `translate(${n.x},${n.y})`)
}

const dragging = new Set<string>()
const dragBehavior = drag<SVGGElement, SimNode>()
  .clickDistance(8)
  .on('start', (ev, n) => {
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

watch(hops, () => void load())

function centerOn(n: SimNode | undefined) {
  const el = svg.value
  if (!el || !zoomer || !n) return
  select(el).transition().duration(450).call(zoomer.translateTo, n.x, n.y)
}

function fit(animate = true) {
  const el = svg.value
  if (!el || !zoomer || simNodes.length === 0) return
  const w = el.clientWidth
  const h = el.clientHeight
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of simNodes) {
    const half = Math.max(n.r, (n.text.length * CHAR_W) / 2) + 8
    minX = Math.min(minX, n.x - half)
    maxX = Math.max(maxX, n.x + half)
    minY = Math.min(minY, n.y - n.r - 12)
    maxY = Math.max(maxY, n.y + n.r + 28)
  }
  const k = Math.min(1.6, w / (maxX - minX), h / (maxY - minY))
  const t = zoomIdentity
    .translate(w / 2, h / 2)
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
  gNodes = root.append('g').attr('class', 'nodes')
  zoomer = zoom<SVGSVGElement, unknown>()
    .scaleExtent([0.2, 5])
    .on('zoom', (ev) => root.attr('transform', ev.transform.toString()))
  select(el).call(zoomer).on('dblclick.zoom', null)
  sim = forceSimulation<SimNode>([])
    .force(
      'link',
      forceLink<SimNode, SimEdge>([])
        .distance((e) => (e.type === 'child' ? 60 : 120))
        .strength((e) => (e.type === 'child' ? 0.8 : 0.4)),
    )
    .force('charge', forceManyBody<SimNode>().strength(-340).distanceMax(500))
    .force('collide', forceCollide<SimNode>((n) => n.r + 10 + (n.text.length * CHAR_W) / 3).iterations(2))
    // Phones are portrait: pull harder sideways than vertically.
    .force('x', forceX<SimNode>(0).strength(0.06))
    .force('y', forceY<SimNode>(0).strength(0.02))
    .alphaDecay(0.035)
    .on('tick', ticked)
  sim.stop()
  void load()
})

onBeforeUnmount(() => {
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
        <KindIcon :kind="focus.kind" />
        <div class="focus-text">
          <span class="focus-label">{{ focus.label || 'Untitled' }}</span>
          <span class="focus-meta">
            {{ KIND_NAMES[focus.kind] }}, {{ data!.nodes.length - 1 }} nearby{{ data?.truncated ? ' (nearest 150)' : '' }}
          </span>
        </div>
        <button type="button" class="btn btn-small btn-primary" @click="openFocus">Open</button>
      </div>
    </div>
    <div class="graph-legend">
      <span><svg width="28" height="8"><line x1="0" y1="4" x2="28" y2="4" class="edge-child" /></svg> Nested</span>
      <span><svg width="28" height="8"><line x1="0" y1="4" x2="28" y2="4" class="edge-link" /></svg> Link</span>
      <span class="legend-hint">Tap to focus, drag to move</span>
    </div>
  </div>
</template>
