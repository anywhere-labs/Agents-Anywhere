// Pure, framework-free reconciliation between the durable message↔attachment
// records (IndexedDB) and the real server timeline. Kept out of the React
// component so it can be unit-tested directly.
//
// Dedup: connector adapters tag each real user-message item with
// `source.clientMessageId` (= the optimistic temp id). Match is by id only.
//
// Attachment rehydration: the server item carries no attachment refs (codex
// only echoes back text; the connector injects a "[Attached file: …]" mention
// for non-image files). We restore them from a local durable record keyed by
// the same client id.

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
  createdAt: string;
};

export type ReconcileSentRecord = {
  sentId: string;
  text: string;
  createdAt: string;
  attachments: ReconcileAttachment[];
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

// Map each durable sent-record to its real timeline counterpart by client id.
// Result: timeline-item id → attachment descriptors to merge in for rendering.
export function assignSentRecords(
  real: ReconcileItem[],
  sentRecords: ReconcileSentRecord[],
): Map<string, ReconcileAttachment[]> {
  const out = new Map<string, ReconcileAttachment[]>();
  if (sentRecords.length === 0) return out;
  const bySentId = new Map(sentRecords.map((r) => [r.sentId, r]));
  for (const item of real) {
    if (item.type !== "message" || item.role !== "user") continue;
    if (extractAttachments(item.content).length > 0) continue;
    const clientId = (item.source as { clientMessageId?: string } | undefined)
      ?.clientMessageId;
    if (!clientId) continue;
    const rec = bySentId.get(clientId);
    if (rec) out.set(item.id, rec.attachments);
  }
  return out;
}
