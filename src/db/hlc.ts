// Hybrid logical clock: timestamps that sort the same everywhere, used to pick
// the newest value of each field when devices sync. Format (fixed width, so
// plain string comparison orders them):
//   <wall ms, base36, 9 chars>-<counter, base36, 4 chars>-<device id>
// The wall clock part follows real time but never runs backwards, and it jumps
// forward past anything seen from another device, so an edit made after
// seeing a change always sorts after it, even if this device's clock is slow.

/** Clock of seed data (the welcome pad): older than any real edit, and never sent as is. */
export const ZERO_HLC = '0'

/**
 * Clock of a field we haven't received yet (a node that arrived without it,
 * or a parent that arrived after its child): anything beats it.
 */
export const UNKNOWN_HLC = ''

export class Hlc {
  #wall = 0
  #count = 0

  constructor(
    readonly device: string,
    private now: () => number,
  ) {}

  /** A new timestamp for a local change. */
  tick(): string {
    const t = this.now()
    if (t > this.#wall) {
      this.#wall = t
      this.#count = 0
    } else {
      this.#count++
    }
    return formatHlc(this.#wall, this.#count, this.device)
  }

  /** Wall clocks further ahead than this are implausible; matches the server's HLC_MAX_SKEW. */
  static readonly MAX_SKEW = 48 * 60 * 60 * 1000

  /** Move past a timestamp seen elsewhere (or stored earlier). */
  observe(h: string | null | undefined): void {
    const p = parseHlc(h)
    if (!p) return
    // A far-future clock observed here would make this device stamp every field
    // into the implausible future (which peers reject), so refuse to adopt it.
    if (p.wall > this.now() + Hlc.MAX_SKEW) return
    if (p.wall > this.#wall || (p.wall === this.#wall && p.count > this.#count)) {
      this.#wall = p.wall
      this.#count = p.count
    }
  }
}

export function formatHlc(wall: number, count: number, device: string): string {
  return `${wall.toString(36).padStart(9, '0')}-${count.toString(36).padStart(4, '0')}-${device}`
}

/** The format formatHlc produces and parseHlc accepts; shared with validators that must match it exactly. */
export const HLC_RE = /^([0-9a-z]{9})-([0-9a-z]{4})-(.+)$/

export function parseHlc(h: string | null | undefined): { wall: number; count: number; device: string } | null {
  if (!h) return null
  const m = HLC_RE.exec(h)
  if (!m) return null
  return { wall: parseInt(m[1], 36), count: parseInt(m[2], 36), device: m[3] }
}

/** Wall-clock milliseconds of a timestamp (0 for the seed clock). */
export function hlcWall(h: string): number {
  return parseHlc(h)?.wall ?? 0
}
