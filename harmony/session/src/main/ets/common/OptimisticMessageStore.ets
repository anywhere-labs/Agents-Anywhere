import { RemoteTimelineItem } from 'network';

// Optimistic timeline items are prefixed with this marker so they can be
// told apart from server-confirmed items without extra flags.
export const OPTIMISTIC_PREFIX = 'opt_';

// Mirrors the timeline ordering used by SessionDetailPage.sortItems so stored
// optimistic messages re-appear in the same position after a page re-entry.
function sortStoredItems(items: RemoteTimelineItem[]): RemoteTimelineItem[] {
  const sorted = items.slice(0);
  sorted.sort((left: RemoteTimelineItem, right: RemoteTimelineItem): number => {
    if (left.orderSeq !== right.orderSeq) {
      return left.orderSeq - right.orderSeq;
    }
    if (left.updatedSeq !== right.updatedSeq) {
      return left.updatedSeq - right.updatedSeq;
    }
    return left.createdAt.localeCompare(right.createdAt);
  });
  return sorted;
}

/**
 * Process-local storage for user messages that have not yet been confirmed by
 * the server (mirrors Android SessionOptimisticMessageStore, which is an
 * in-memory per-process map — no disk persistence, no TTL). Keeping the items
 * here lets a freshly entered SessionDetailPage render the in-flight
 * "sending" bubbles the previous page instance created before navigating away.
 */
export class OptimisticMessageStore {
  private static instance: OptimisticMessageStore | null = null;
  private messagesBySession: Map<string, RemoteTimelineItem[]> = new Map();

  static getInstance(): OptimisticMessageStore {
    if (OptimisticMessageStore.instance === null) {
      OptimisticMessageStore.instance = new OptimisticMessageStore();
    }
    return OptimisticMessageStore.instance;
  }

  // Returns a copy: callers must not mutate the stored lists in place.
  read(sessionId: string): RemoteTimelineItem[] {
    const stored = this.messagesBySession.get(sessionId);
    if (stored === undefined) {
      return [];
    }
    return stored.slice(0);
  }

  upsert(sessionId: string, item: RemoteTimelineItem): void {
    const existing = this.read(sessionId);
    const merged: RemoteTimelineItem[] = [];
    let replaced = false;
    for (const current of existing) {
      if (current.id === item.id) {
        merged.push(item);
        replaced = true;
      } else {
        merged.push(current);
      }
    }
    if (!replaced) {
      merged.push(item);
    }
    this.messagesBySession.set(sessionId, sortStoredItems(merged));
  }

  remove(sessionId: string, clientMessageId: string): void {
    const stored = this.messagesBySession.get(sessionId);
    if (stored === undefined) {
      return;
    }
    const remaining: RemoteTimelineItem[] = [];
    for (const item of stored) {
      if (item.id.startsWith(OPTIMISTIC_PREFIX) && item.clientMessageId === clientMessageId) {
        continue;
      }
      remaining.push(item);
    }
    if (remaining.length === 0) {
      this.messagesBySession.delete(sessionId);
      return;
    }
    this.messagesBySession.set(sessionId, remaining);
  }

  // Reconciliation entry point (Android `replace`): the page feeds its full
  // item list after every merge/snapshot replace and the store keeps only the
  // still-unconfirmed optimistic subset. Items whose clientMessageId has been
  // confirmed by a server item are dropped here because the page already
  // removed them from its list.
  sync(sessionId: string, items: RemoteTimelineItem[]): void {
    const pending: RemoteTimelineItem[] = [];
    for (const item of items) {
      if (item.id.startsWith(OPTIMISTIC_PREFIX)) {
        pending.push(item);
      }
    }
    if (pending.length === 0) {
      this.messagesBySession.delete(sessionId);
      return;
    }
    this.messagesBySession.set(sessionId, sortStoredItems(pending));
  }

  clear(sessionId: string): void {
    this.messagesBySession.delete(sessionId);
  }
}
