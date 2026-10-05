// Types for relations-ai.mjs (plain JS so it runs without a build step).
import type { SyncServer } from './sync-server.mjs'

export function textHash(s: string): string
export function cleanRelation(r: unknown): string | null

export interface LabelItem {
  id: string
  line: string
  linked: string
  under?: string
}
export interface Vocabulary {
  relations: string[]
  sameAs: Record<string, string>
  notRelations: string[]
}
export type Classifier = (
  items: LabelItem[],
  vocabulary: Vocabulary,
) => Promise<{ labels: { id: string; relation: string | null }[]; usage?: { input_tokens: number; output_tokens: number } }>

export class RelationLabeler {
  constructor(
    sync: SyncServer,
    classify: Classifier,
    opts?: { model?: string; batch?: number; delayMs?: number; maxCallsPerDay?: number; log?: (msg: string) => void },
  )
  start(): this
  stop(): void
  schedule(ms?: number): void
  run(): Promise<void>
  pending(limit?: number): { src: string; dst: string; text: string; h: string }[]
  vocabulary(max?: number): Vocabulary
  stats(): Record<string, unknown>
}

export function claudeClassifier(opts: { apiKey: string; model?: string; fetchImpl?: typeof fetch }): Classifier
