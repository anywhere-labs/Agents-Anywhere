// IndexedDB-backed cache for user-uploaded attachments.
//
// The backend deletes blobs as soon as the connector has consumed them, so the
// browser is the only place a preview thumbnail lives for "messages I sent
// earlier." We key by fileId (returned from POST /sessions/{id}/uploads) and
// store the raw Blob; the UI reconstitutes an object URL on demand.
//
// Cross-device limitation: opening the same session in a different browser
// won't have these cached → preview falls back to file name only. That's the
// explicit trade-off for not keeping bytes server-side.

export type CachedAttachment = {
  fileId: string;
  sessionId: string;
  name: string;
  mediaType: string;
  size: number;
  blob: Blob;
  createdAt: string;
};

// Durable "which message carried which attachments" association. The server
// timeline item for a user message does NOT carry attachment refs (codex only
// echoes back text — and for non-image files the connector injects a path
// mention into that text), so this is the only place the message↔fileId link
// survives a page refresh. Keyed by a client-generated sentId; indexed by
// sessionId so we can re-attach on load.
export type SentAttachmentMeta = {
  fileId: string;
  name: string;
  mediaType: string;
  size: number;
};

export type SentMessageRecord = {
  sentId: string;
  sessionId: string;
  text: string;
  attachments: SentAttachmentMeta[];
  createdAt: string;
};

const DB_NAME = "aa-attachments";
const STORE = "files";
const SENT_STORE = "sent";
const DB_VERSION = 2;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "fileId" });
        store.createIndex("sessionId", "sessionId", { unique: false });
      }
      if (!db.objectStoreNames.contains(SENT_STORE)) {
        const sent = db.createObjectStore(SENT_STORE, { keyPath: "sentId" });
        sent.createIndex("sessionId", "sessionId", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
  });
  return dbPromise;
}

export async function putAttachment(entry: CachedAttachment): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("put failed"));
  });
}

export async function getAttachment(
  fileId: string,
): Promise<CachedAttachment | null> {
  const db = await openDb();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(fileId);
    req.onsuccess = () => resolve((req.result as CachedAttachment) ?? null);
    req.onerror = () => reject(req.error ?? new Error("get failed"));
  });
}

export async function putSentMessage(entry: SentMessageRecord): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(SENT_STORE, "readwrite");
    tx.objectStore(SENT_STORE).put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("put sent failed"));
  });
}

export async function listSentMessages(
  sessionId: string,
): Promise<SentMessageRecord[]> {
  const db = await openDb();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(SENT_STORE, "readonly");
    const index = tx.objectStore(SENT_STORE).index("sessionId");
    const req = index.getAll(sessionId);
    req.onsuccess = () => resolve((req.result as SentMessageRecord[]) ?? []);
    req.onerror = () => reject(req.error ?? new Error("list sent failed"));
  });
}

// Object URLs leak unless revoked. We cache by fileId so re-renders reuse the
// same URL; callers shouldn't revoke individually.
const urlCache = new Map<string, string>();

export function urlForCached(entry: CachedAttachment): string {
  const existing = urlCache.get(entry.fileId);
  if (existing) return existing;
  const url = URL.createObjectURL(entry.blob);
  urlCache.set(entry.fileId, url);
  return url;
}

export function isImageMediaType(media: string | undefined | null): boolean {
  return typeof media === "string" && media.startsWith("image/");
}
