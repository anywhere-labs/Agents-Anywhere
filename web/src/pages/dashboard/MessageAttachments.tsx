import { useEffect, useState, type MouseEvent } from "react";

import {
  getAttachment,
  isImageMediaType,
  putAttachment,
  urlForCached,
  type CachedAttachment,
} from "../../lib/attachmentCache";
import { Icons } from "../../components/Icons";
import { loadSession } from "../../lib/session";

export type AttachmentDescriptor = {
  fileId: string;
  name?: string;
  size?: number;
  mediaType?: string;
};

type ImagePreview = {
  src: string;
  name: string;
  size?: number;
  revoke?: boolean;
};

export function MessageAttachments({
  sessionId,
  attachments,
}: {
  sessionId: string;
  attachments: AttachmentDescriptor[];
}) {
  const [preview, setPreview] = useState<ImagePreview | null>(null);

  useEffect(() => {
    if (!preview) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreview(null);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (preview.revoke) URL.revokeObjectURL(preview.src);
    };
  }, [preview]);

  if (!attachments || attachments.length === 0) return null;
  return (
    <>
      <div className="kl-msg-attachments">
        {attachments.map((att) => (
          <AttachmentTile
            key={att.fileId}
            sessionId={sessionId}
            descriptor={att}
            onPreview={setPreview}
          />
        ))}
      </div>
      {preview && (
        <div className="kl-img-preview" role="dialog" aria-modal="true">
          <button
            type="button"
            className="kl-img-preview-backdrop"
            aria-label="Close image preview"
            onClick={() => setPreview(null)}
          />
          <div className="kl-img-preview-inner">
            <button
              type="button"
              className="kl-img-preview-close"
              aria-label="Close image preview"
              onClick={() => setPreview(null)}
            >
              ×
            </button>
            <img src={preview.src} alt={preview.name} />
            <div className="kl-img-preview-caption">
              <span>{preview.name}</span>
              {typeof preview.size === "number" && <em>{formatBytes(preview.size)}</em>}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function AttachmentTile({
  sessionId,
  descriptor,
  onPreview,
}: {
  sessionId: string;
  descriptor: AttachmentDescriptor;
  onPreview: (preview: ImagePreview) => void;
}) {
  const [cached, setCached] = useState<CachedAttachment | null | "loading">(
    "loading",
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const entry = await getAttachment(descriptor.fileId);
        if (entry || !isImageMediaType(descriptor.mediaType)) {
          if (!cancelled) setCached(entry);
          return;
        }
        const fetched = await fetchAttachmentBlob(sessionId, descriptor);
        if (!cancelled) setCached(fetched);
      } catch {
        if (!cancelled) setCached(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    descriptor.fileId,
    descriptor.mediaType,
    descriptor.name,
    descriptor.size,
    sessionId,
  ]);

  const name = cached && cached !== "loading" ? cached.name : descriptor.name;
  const mediaType =
    cached && cached !== "loading" ? cached.mediaType : descriptor.mediaType;
  const sizeBytes =
    cached && cached !== "loading" ? cached.size : descriptor.size;
  const isImage = isImageMediaType(mediaType);
  const platformUrl = attachmentOpenUrl(sessionId, descriptor.fileId);

  if (cached === "loading") {
    // Skeleton placeholder — short enough that you barely see it but stable
    // height keeps the bubble from jumping when the IndexedDB read resolves.
    return <div className="kl-msg-att skeleton" aria-busy="true" />;
  }

  if (cached && isImage) {
    const cachedUrl = urlForCached(cached);
    return (
      <a
        className="kl-msg-att image"
        href={platformUrl || cachedUrl}
        onClick={(event) => {
          event.preventDefault();
          onPreview({ src: cachedUrl, name: cached.name, size: cached.size });
        }}
        title={`${cached.name} · ${formatBytes(cached.size)}`}
      >
        <img src={cachedUrl} alt={cached.name} />
      </a>
    );
  }

  if (!cached && isImage) {
    return (
      <a
        className="kl-msg-att image missing"
        href={platformUrl}
        onClick={openPlatformImage(platformUrl, {
          name: name ?? descriptor.fileId,
          size: sizeBytes,
          onPreview,
        })}
        title={name ?? descriptor.fileId}
      >
        <span className="kl-msg-att-image-fallback">
          {name ?? descriptor.fileId}
        </span>
      </a>
    );
  }

  // Non-image OR no IndexedDB hit. Show name + size, and open the durable
  // platform file through the authenticated backend route.
  const body = (
    <>
      <span className="kl-msg-att-icon">
        <Icons.File size={16} />
      </span>
      <span className="kl-msg-att-main">
        <span className="kl-msg-att-name">{name ?? descriptor.fileId}</span>
        <span className="kl-msg-att-meta">
          {attachmentMetaLabel(mediaType, sizeBytes)}
        </span>
      </span>
      <span className="kl-msg-att-open">
        <Icons.External size={13} />
      </span>
    </>
  );
  return (
    <a
      className={`kl-msg-att file${cached ? "" : " missing"}`}
      href={platformUrl}
      target="_blank"
      rel="noreferrer"
      onClick={openPlatformFile(platformUrl)}
    >
      {body}
    </a>
  );
}

function attachmentOpenUrl(sessionId: string, fileId: string): string {
  return `/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(fileId)}/open`;
}

async function fetchAttachmentBlob(
  sessionId: string,
  descriptor: AttachmentDescriptor,
): Promise<CachedAttachment> {
  const response = await fetchWithAuth(attachmentOpenUrl(sessionId, descriptor.fileId));
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  const entry: CachedAttachment = {
    fileId: descriptor.fileId,
    sessionId,
    name: descriptor.name ?? descriptor.fileId,
    mediaType: descriptor.mediaType || blob.type || "application/octet-stream",
    size: descriptor.size ?? blob.size,
    blob,
    createdAt: new Date().toISOString(),
  };
  await putAttachment(entry);
  return entry;
}

function openPlatformFile(url: string) {
  return async (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    window.open(authenticatedOpenUrl(url), "_blank", "noopener,noreferrer");
  };
}

function openPlatformImage(
  url: string,
  opts: {
    name: string;
    size?: number;
    onPreview: (preview: ImagePreview) => void;
  },
) {
  return async (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    try {
      const response = await fetchWithAuth(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      opts.onPreview({
        src: URL.createObjectURL(blob),
        name: opts.name,
        size: opts.size,
        revoke: true,
      });
      return;
    } catch {
      window.open(authenticatedOpenUrl(url), "_blank", "noopener,noreferrer");
    }
  };
}

function authenticatedOpenUrl(url: string): string {
  const session = loadSession();
  if (!session?.accessToken) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}token=${encodeURIComponent(session.accessToken)}`;
}

function fetchWithAuth(url: string): Promise<Response> {
  const session = loadSession();
  const headers = new Headers();
  if (session?.accessToken) headers.set("authorization", `Bearer ${session.accessToken}`);
  return fetch(url, { headers });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function attachmentMetaLabel(mediaType: string | undefined, size: number | undefined): string {
  const kind = fileKindLabel(mediaType);
  if (typeof size !== "number") return kind;
  return `${kind} · ${formatBytes(size)}`;
}

function fileKindLabel(mediaType: string | undefined): string {
  if (!mediaType) return "File";
  if (mediaType === "application/pdf") return "PDF";
  if (mediaType.startsWith("text/")) return "Text";
  if (mediaType.includes("json")) return "JSON";
  if (mediaType.includes("zip") || mediaType.includes("archive")) return "Archive";
  return mediaType.split(";")[0] || "File";
}
