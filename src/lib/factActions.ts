// Facts: things you state about a node, like Alex is "cofounder of"
// Acme. Add one, change or remove it, or make a note under a node into
// one. Never guessed: facts are only what you make.

import { api } from '@/db/api'
import type { FactView } from '@/db/types'
import { router } from '@/router'
import { createOptions } from '@/lib/linking'
import { pickRelation } from '@/lib/relationActions'
import { labelize, parseTokens, splitTokens } from '@/lib/tokens'
import { refCache } from '@/state/refs'
import { openPicker, openSheet, reportError, toast } from '@/state/ui'

type Subject = { id: string; label: string }

function pickTarget(title: string, subject: Subject, onPick: (r: { id: string; label: string }) => void) {
  openPicker({
    mode: 'link',
    title,
    placeholder: 'What it’s about',
    excludeIds: [subject.id],
    allowCreate: true,
    createOptions: createOptions(),
    onPick,
  })
}

/** "Add a fact": pick a relation (or name one), then what it's about. */
export function addFact(subject: Subject): void {
  pickRelation(`${subject.label} is…`, (rel) =>
    pickTarget(`${subject.label} is ${rel.label}…`, subject, (t) =>
      void api
        .addFact(subject.id, rel.id, t.id)
        .then(() => toast(`${subject.label} is ${rel.label} ${t.label}`))
        .catch(reportError),
    ),
  )
}

export function openFactSheet(subject: Subject, f: FactView): void {
  openSheet({
    title: `${subject.label} is ${f.name} ${f.target.label}`,
    actions: [
      { label: `Open “${f.target.label}”`, icon: 'open', run: () => void router.push(`/n/${f.target.id}`) },
      {
        label: 'Change the relation…',
        icon: 'linked',
        run: () =>
          pickRelation(`${subject.label} is … ${f.target.label}`, (rel) =>
            void api.updateFact(subject.id, f.index, { relationId: rel.id }).catch(reportError),
          ),
      },
      {
        label: 'Point it at something else…',
        icon: 'move',
        run: () =>
          pickTarget(`${subject.label} is ${f.name}…`, subject, (t) =>
            void api.updateFact(subject.id, f.index, { to: t.id }).catch(reportError),
          ),
      },
      {
        label: 'Turn it back into a note',
        icon: 'dot',
        run: () => void api.factToNote(subject.id, f.index).catch(reportError),
      },
      {
        label: 'Remove this fact',
        icon: 'trash',
        danger: true,
        run: () => void api.removeFact(subject.id, f.index).then(() => toast('Fact removed')).catch(reportError),
      },
    ],
  })
}

/**
 * Make a note a fact about what it's under. The relation starts as the
 * note's own words ("cofounder of"); if it links to several things, choose one.
 */
export function noteToFact(line: { id: string; text: string }, subject: Subject): void {
  const targets = parseTokens(line.text)
  if (!targets.length) {
    toast('Link it to what it’s about first (type @), then make it a fact.', { ms: 5000 })
    return
  }
  const words = splitTokens(line.text)
    .filter((s) => s.type === 'text')
    .map((s) => (s as { value: string }).value)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
  const withTarget = (to: string) =>
    pickRelation(
      `Make it a fact about “${subject.label}”`,
      (rel) =>
        void api
          .noteToFact(line.id, rel.id, to)
          .then(() => toast(`${subject.label} is ${rel.label} ${refCache[to]?.label ?? ''}`.trim()))
          .catch(reportError),
      [],
      words,
    )
  if (targets.length === 1) return withTarget(targets[0])
  openSheet({
    title: 'What is it about?',
    actions: targets.map((t) => ({
      label: labelize(`[[${t}]]`, (id) => refCache[id]?.label) || 'Untitled',
      icon: 'linked',
      run: () => withTarget(t),
    })),
  })
}
