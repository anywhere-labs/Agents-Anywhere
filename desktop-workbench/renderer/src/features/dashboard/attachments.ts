export type ReconcileAttachment = {
  fileId: string;
  name?: string;
  size?: number;
  mediaType?: string;
  path?: string;
  root?: string;
  openUrl?: string;
  downloadUrl?: string;
  previewUrl?: string;
  optimistic?: boolean;
};

export function attachmentShouldReadFromDevice(
  attachment: ReconcileAttachment,
  hasAttachmentUrl = false,
): boolean {
  return Boolean(
    !hasAttachmentUrl
    && !attachment.fileId.startsWith("file_")
    && attachment.path
    && !attachment.optimistic
    && !attachment.openUrl
    && !attachment.downloadUrl,
  );
}

export function attachmentIsImage(name: string, mediaType: string): boolean {
  if (mediaType.toLowerCase().startsWith("image/")) return true;
  return /\.(png|apng|jpe?g|gif|webp|avif|svg)$/i.test(name);
}

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
    if (typeof obj.path === "string") att.path = obj.path;
    if (typeof obj.root === "string") att.root = obj.root;
    if (typeof obj.openUrl === "string") att.openUrl = obj.openUrl;
    if (typeof obj.downloadUrl === "string") att.downloadUrl = obj.downloadUrl;
    if (typeof obj.previewUrl === "string") att.previewUrl = obj.previewUrl;
    if (obj.optimistic === true) att.optimistic = true;
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
