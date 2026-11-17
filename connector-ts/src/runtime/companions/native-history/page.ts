// 原生历史的分页：游标是条目下标，从最新往前取 limit 条。

import type { HistoryItem, HistoryWindow, NativeHistoryPage } from '../../../application/ports/runtime-session.js'

export function historyPage(items: readonly HistoryItem[], window: HistoryWindow): NativeHistoryPage {
  const end = window.cursor !== undefined && /^\d+$/.test(window.cursor) ? Math.min(Number(window.cursor), items.length) : items.length
  const start = window.limit > 0 ? Math.max(0, end - window.limit) : 0
  return { items: items.slice(start, end), ...(start > 0 ? { olderCursor: String(start) } : {}) }
}
