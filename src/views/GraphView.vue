<script setup lang="ts">
// Read-only neighborhood graph around a node. Layout is computed once with
// d3-force (no animation), then the view can be panned and pinch-zoomed.

import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationNodeDatum } from 'd3-force'
import { select } from 'd3-selection'
import { zoom, zoomIdentity, type ZoomBehavior } from 'd3-zoom'
import Icon from '@/components/Icon.vue'
import { api } from '@/db/api'
import type { GraphNode, Kind, Neighborhood } from '@/db/types'
import { reportError } from '@/state/ui'

const props = defineProps<{ id: string }>()
const router = useRouter()

interface SimNode extends SimulationNodeDatum, GraphNode {
  x: number
  y: number
  r: number
  /** Shown label ('' when the graph is busy and this node is minor). */
  text: string
}
interface SimEdge {
  source: SimNode
  target: SimNode
  type: 'child' | 'link'
}

const hops = ref(2)
const data = shallowRef<Neighborhood | null>(null)
const nodes = shallowRef<SimNode[]>([])
const edges = shallowRef<SimEdge[]>([])
const svg = ref<SVGSVGElement>()
const transform = ref('translate(0,0) scale(1)')
let zoomer: ZoomBehavior<SVGSVGElement, unknown> | null = null

const center = computed(() => nodes.value.find((n) => n.id === props.id))

const RADIUS: Record<Kind, number> = { pad: 13, item: 8, place: 12, person: 12 }

const CHAR_W = 6.8

function truncate(s: string, n = 18) {
  const t = s || 'Untitled'
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

async function load() {
  try {
    data.value = await api.getNeighborhood(props.id, hops.value, 150)
    layout()
  } catch (e) {
    reportError(e)
  }
}

function layout() {
  const d = data.value
  if (!d) return
  const busy = d.nodes.length > 18
  const simNodes: SimNode[] = d.nodes.map((n) => {
    const major = n.id === d.center || n.kind !== 'item' || n.hop <= 1
    return {
      ...n,
      r: n.id === d.center ? RADIUS[n.kind] + 5 : RADIUS[n.kind],
      text: !busy || major ? truncate(n.label, n.id === d.center ? 26 : 18) : '',
      x: (Math.random() - 0.5) * 200,
      y: (Math.random() - 0.5) * 300,
    }
  })
  const byId = new Map(simNodes.map((n) => [n.id, n]))
  const centerNode = byId.get(d.center)
  if (centerNode) {
    centerNode.fx = 0
    centerNode.fy = 0
  }
  const simEdges: SimEdge[] = d.edges
    .filter((e) => byId.has(e.src) && byId.has(e.dst))
    .map((e) => ({ source: byId.get(e.src)!, target: byId.get(e.dst)!, type: e.type }))
  const sim = forceSimulation<SimNode>(simNodes)
    .force(
      'link',
      forceLink<SimNode, SimEdge>(simEdges)
        .distance((e) => (e.type === 'child' ? 60 : 120))
        .strength((e) => (e.type === 'child' ? 0.8 : 0.4)),
    )
    .force('charge', forceManyBody<SimNode>().strength(-340).distanceMax(500))
    // Labels sit under the discs, so give labelled nodes more elbow room.
    .force('collide', forceCollide<SimNode>((n) => n.r + 10 + (n.text.length * CHAR_W) / 3).iterations(2))
    // Phones are portrait: pull harder sideways than vertically.
    .force('x', forceX<SimNode>(0).strength(0.09))
    .force('y', forceY<SimNode>(0).strength(0.025))
    .stop()
  sim.tick(400)
  nodes.value = simNodes
  edges.value = simEdges
  fit()
}

function fit() {
  const el = svg.value
  if (!el || !zoomer || nodes.value.length === 0) return
  const w = el.clientWidth
  const h = el.clientHeight
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of nodes.value) {
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
  select(el).call(zoomer.transform, t)
}

/** Line endpoints pulled back to the node rims (so arrowheads show). */
function seg(e: SimEdge) {
  const dx = e.target.x - e.source.x
  const dy = e.target.y - e.source.y
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len
  const uy = dy / len
  const pad = e.type === 'link' ? 4 : 0
  return {
    x1: e.source.x + ux * e.source.r,
    y1: e.source.y + uy * e.source.r,
    x2: e.target.x - ux * (e.target.r + pad),
    y2: e.target.y - uy * (e.target.r + pad),
  }
}

function open(n: SimNode) {
  void router.push(`/n/${n.id}`)
}

watch(hops, load)

onMounted(() => {
  if (svg.value) {
    zoomer = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 5])
      .on('zoom', (ev) => {
        transform.value = ev.transform.toString()
      })
    select(svg.value).call(zoomer)
  }
  void load()
})

onBeforeUnmount(() => {
  if (svg.value) select(svg.value).on('.zoom', null)
})
</script>

<template>
  <div class="page graph-page">
    <header class="topbar">
      <RouterLink class="back" :to="`/n/${id}`">
        <Icon name="chevron-left" />
        <span class="back-label">{{ center ? truncate(center.label, 28) : 'Back' }}</span>
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
    <svg ref="svg" class="graph" role="img" aria-label="Graph of connected items">
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0L10 5L0 10z" class="arrowhead" />
        </marker>
      </defs>
      <g :transform="transform">
        <g class="edges">
          <line
            v-for="(e, i) in edges"
            :key="i"
            v-bind="seg(e)"
            :class="e.type === 'link' ? 'edge-link' : 'edge-child'"
            :marker-end="e.type === 'link' ? 'url(#arrow)' : undefined"
          />
        </g>
        <g class="nodes">
          <g
            v-for="n in nodes"
            :key="n.id"
            class="gnode"
            :class="[`kind-${n.kind}`, { center: n.id === id, done: n.done }]"
            :transform="`translate(${n.x},${n.y})`"
            role="link"
            :aria-label="n.label || 'Untitled'"
            @click="open(n)"
          >
            <circle :r="n.r + 10" class="hit" />
            <circle :r="n.r" class="disc" />
            <text v-if="n.text" :y="n.r + 15" text-anchor="middle">{{ n.text }}</text>
          </g>
        </g>
      </g>
    </svg>
    <div class="graph-legend">
      <span><svg width="28" height="8"><line x1="0" y1="4" x2="28" y2="4" class="edge-child" /></svg> Nested</span>
      <span><svg width="28" height="8"><line x1="0" y1="4" x2="28" y2="4" class="edge-link" /></svg> Link</span>
      <span v-if="data?.truncated" class="truncated">Showing the nearest 150</span>
    </div>
  </div>
</template>
