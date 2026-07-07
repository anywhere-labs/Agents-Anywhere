// IndexedDB-backed preview cache for user-uploaded attachments. The backend
// keeps durable platform files and timeline attachment metadata; this local
// copy only lets recent image thumbnails render immediately.

export type CachedAttachment = {
  fileId: string;
  sessionId: string;
  name: string;
  mediaType: string;
  size: number;
  blob: Blob;
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
