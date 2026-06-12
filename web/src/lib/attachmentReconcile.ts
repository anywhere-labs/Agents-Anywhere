// Pure, framework-free helpers for timeline attachment rendering and optimistic
// message reconciliation. Kept out of the React component so they can be
// unit-tested directly.
//
// Dedup: connector adapters tag each real user-message item with
// `source.clientMessageId` (= the optimistic temp id). Match is by id only.
//
export type ReconcileAttachment = {
  fileId: string;
  name?: string;
  size?: number;
  mediaType?: string;
};

export type ReconcileItem = {
  id: string;
  type: string;
  role: string | null;
  content: Record<string, unknown>;
  source?: Record<string, unknown>;
  turnId?: string | null;
  status?: string;
  orderSeq?: number;
  updatedSeq?: number;
  revision?: number;
  contentHash?: string;
  createdAt: string;
  updatedAt?: string;
  completedAt?: string | null;
};

export function extractAttachments(
  content: Record<string, unknown>,
): ReconcileAttachment[] {
  const raw = (content as { attachments?: unknown }).attachments;
  if (!Array.isArray(raw)) return [];
  const out: ReconcileAttachment[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const fileId = obj.fileId;
    if (typeof fileId !== "string" || !fileId) continue;
    const att: ReconcileAttachment = { fileId };
    if (typeof obj.name === "string") att.name = obj.name;
    if (typeof obj.size === "number") att.size = obj.size;
    if (typeof obj.mediaType === "string") att.mediaType = obj.mediaType;
    out.push(att);
  }
  return out;
}

// The connector appends machine-readable mentions after the user's text when
// forwarding non-image file attachments. They always sit at the end and begin
// with one of these markers. Hide them in the user's own bubble.
const INJECTED_MENTION_MARKERS = [
  "\n\n[Attached file: ",
  "\n\n[Failed to load attachment ",
  "\n\n[Attachments dropped ",
];

export function stripInjectedAttachmentMentions(text: string): string {
  let cut = text.length;
  for (const marker of INJECTED_MENTION_MARKERS) {
    const idx = text.indexOf(marker);
    if (idx !== -1 && idx < cut) cut = idx;
  }
  return text.slice(0, cut).trimEnd();
}

export function userMessageMatches(
  real: ReconcileItem,
  clientId: string,
): boolean {
  if (real.type !== "message" || real.role !== "user") return false;
  const realClientId = (real.source as { clientMessageId?: string } | undefined)
    ?.clientMessageId;
  return Boolean(realClientId && realClientId === clientId);
}

export function mergeOptimisticTimelineItems<T extends ReconcileItem>(
  realItems: T[],
  optimisticItems: T[],
): T[] {
  if (optimisticItems.length === 0) return realItems;
  const pending = optimisticItems.filter(
    (opt) =>
      opt.status === "failed" ||
      !realItems.some((real) => userMessageMatches(real, opt.id)),
  );
  if (pending.length === 0) return realItems;

  const out = [...realItems];
  for (const optimistic of pending) {
    const anchorTurnId = optimistic.turnId;
    if (!anchorTurnId) {
      out.push(optimistic);
      continue;
    }
    const existingIndex = out.findIndex((item) => item.id === optimistic.id);
    if (existingIndex !== -1) out.splice(existingIndex, 1);
    out.splice(_optimisticInsertIndex(out, anchorTurnId), 0, optimistic);
  }
  return out;
}

function _optimisticInsertIndex(items: ReconcileItem[], turnId: string): number {
  const turnStartIndex = items.findIndex(
    (item) => item.type === "turn.start" && item.turnId === turnId,
  );
  if (turnStartIndex === -1) return items.length;
  let index = turnStartIndex + 1;
  while (
    index < items.length &&
    items[index].turnId === turnId &&
    items[index].type === "message" &&
    items[index].role === "user"
  ) {
    index += 1;
  }
  return index;
}
