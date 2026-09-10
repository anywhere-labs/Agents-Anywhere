export type SequencedTimelineItem = {
  id: string
  updatedSeq: number
}

export type SequencedTimelineSnapshot<T extends SequencedTimelineItem> = {
  items: T[]
  nextSeq: number
}

export function incomingTimelineItemCanReplace<T extends SequencedTimelineItem>(
  current: T,
  incoming: T,
): boolean {
  return incoming.updatedSeq >= current.updatedSeq
}

export function mergeSequencedTimelineSnapshot<T extends SequencedTimelineItem>(
  currentItems: T[],
  currentNextSeq: number,
  snapshotItems: T[],
  snapshotNextSeq: number,
  shouldPreserveCurrentItem: (item: T) => boolean = () => false,
): SequencedTimelineSnapshot<T> {
  const snapshotItemIds = new Set(snapshotItems.map((item) => item.id))
  const byId = new Map<string, T>()

  for (const item of currentItems) {
    if (
      shouldPreserveCurrentItem(item) ||
      item.updatedSeq > snapshotNextSeq ||
      snapshotItemIds.has(item.id)
    ) {
      byId.set(item.id, item)
    }
  }

  for (const item of snapshotItems) {
    const current = byId.get(item.id)
    if (!current || incomingTimelineItemCanReplace(current, item)) {
      byId.set(item.id, item)
    }
  }

  return {
    items: Array.from(byId.values()),
    nextSeq: Math.max(currentNextSeq, snapshotNextSeq),
  }
}
