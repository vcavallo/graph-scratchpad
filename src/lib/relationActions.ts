// What you can do with a link's label: keep a suggestion as one of your
// relations, call it something else (an existing relation or a new name),
// rule it out, rename or merge a relation, or choose the relation for just
// one link. Opened from labels on place/person pages and the Relations list.

import { api } from '@/db/api'
import { NO_RELATION_ID } from '@/db/types'
import { router } from '@/router'
import { openPicker, openSheet, promptDialog, reportError, toast, type PickResult, type SheetAction } from '@/state/ui'

export interface LabelTarget {
  /** What it shows now (your relation's name or the suggestion), or null. */
  label: string | null
  /** The wording it was suggested from. */
  suggested: string | null
  /** Your relation, if it has one (NO_RELATION_ID when ruled out). */
  relationId: string | null
  /** Set when opened from one link: its line and what it links to. */
  link?: { src: string; dst: string; pinned: boolean }
}

/** Pick one of your relations, or name a new one. */
export function pickRelation(title: string, onPick: (r: PickResult) => void, exclude: string[] = [], initialQuery?: string): void {
  openPicker({
    mode: 'link',
    title,
    initialQuery,
    placeholder: 'Find a relation, or type a new one',
    kinds: ['relation'],
    excludeIds: [NO_RELATION_ID, ...exclude],
    allowCreate: true,
    createKinds: ['relation'],
    onPick,
  })
}

const done = (msg: string) => () => toast(msg)

export function openLabelSheet(t: LabelTarget): void {
  const actions: SheetAction[] = []
  const mine = t.relationId && t.relationId !== NO_RELATION_ID ? t.relationId : null
  const word = t.suggested ?? t.label

  if (mine && t.label) {
    const name = t.label
    actions.push(
      { label: `Open “${name}”`, icon: 'open', run: () => void router.push(`/n/${mine}`) },
      {
        label: 'Rename…',
        icon: 'edit',
        run: async () => {
          const next = await promptDialog({ title: `Rename “${name}”`, confirmLabel: 'Rename', value: name })
          if (next) api.renameRelation(mine, next).then(done(`Renamed to “${next.toLowerCase()}”`), reportError)
        },
      },
      {
        label: 'Merge into…',
        icon: 'move',
        run: () =>
          pickRelation(
            `Merge “${name}” into`,
            (r) => void api.mergeRelation(mine, r.id).then(done(`“${name}” is now “${r.label}”`), reportError),
            [mine],
          ),
      },
    )
  } else if (t.relationId === NO_RELATION_ID && !t.link?.pinned && word) {
    actions.push({
      label: `Treat “${word}” as a relation again`,
      icon: 'undo',
      run: () => void api.unignorePhrase(word).then(done(`“${word}” is a suggestion again`), reportError),
    })
  } else if (word && !t.link?.pinned) {
    actions.push(
      { label: `Keep “${word}”`, icon: 'check', run: () => void api.keepRelation(word).then(done(`“${word}” is one of your relations`), reportError) },
      {
        label: 'Call it something else…',
        icon: 'edit',
        run: () =>
          pickRelation(`Call “${word}”`, (r) => void api.keepRelation(word, r.label).then(done(`“${word}” now counts as “${r.label}”`), reportError)),
      },
      { label: 'Not a relation', icon: 'x', run: () => void api.ignorePhrase(word).then(done(`Links worded “${word}” are plain mentions now`), reportError) },
    )
  }

  if (t.link) {
    const { src, dst, pinned } = t.link
    actions.push({
      label: 'Label just this link…',
      icon: 'linked',
      run: () => pickRelation('Label this link', (r) => void api.setLinkRelation(src, dst, r.id).then(done(`This link is “${r.label}”`), reportError)),
    })
    if (pinned) {
      actions.push({
        label: 'Use the usual label for this link',
        icon: 'undo',
        run: () => void api.setLinkRelation(src, dst, null).then(done('Back to the usual label'), reportError),
      })
    } else if (t.label) {
      actions.push({
        label: 'This link isn’t a relation',
        icon: 'x',
        run: () => void api.setLinkRelation(src, dst, NO_RELATION_ID).then(done('This link is a plain mention now'), reportError),
      })
    }
  }
  actions.push({ label: 'All relations', icon: 'list', run: () => void router.push('/relations') })

  const status = mine ? '' : t.relationId === NO_RELATION_ID ? ' (not a relation)' : t.label ? ' (suggested)' : ''
  openSheet({ title: t.label ? `“${t.label}”${status}` : word ? `“${word}”${status}` : 'This link', actions })
}
