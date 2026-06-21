export type ReconcileAttachment = {
  fileId: string;
  name?: string;
  size?: number;
  mediaType?: string;
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
