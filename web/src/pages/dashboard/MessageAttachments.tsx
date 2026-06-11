import { useEffect, useState, type MouseEvent } from "react";

import {
  getAttachment,
  isImageMediaType,
  urlForCached,
  type CachedAttachment,
} from "../../lib/attachmentCache";
import { loadSession } from "../../lib/session";

export type AttachmentDescriptor = {
  fileId: string;
  name?: string;
  size?: number;
  mediaType?: string;
  openUrl?: string;
};

type ImagePreview = {
  src: string;
  name: string;
  size?: number;
  revoke?: boolean;
};

export function MessageAttachments({
  attachments,
}: {
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
  descriptor,
  onPreview,
}: {
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
        if (!cancelled) setCached(entry);
      } catch {
        if (!cancelled) setCached(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [descriptor.fileId]);

  const name = cached && cached !== "loading" ? cached.name : descriptor.name;
  const mediaType =
    cached && cached !== "loading" ? cached.mediaType : descriptor.mediaType;
  const sizeBytes =
    cached && cached !== "loading" ? cached.size : descriptor.size;
  const isImage = isImageMediaType(mediaType);
  const platformUrl = descriptor.openUrl;

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

  if (!cached && isImage && platformUrl) {
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
  // platform file when the server provided a URL.
  const body = (
    <>
      <span className="kl-msg-att-icon" aria-hidden="true">
        📎
      </span>
      <span className="kl-msg-att-name">{name ?? descriptor.fileId}</span>
      {typeof sizeBytes === "number" && (
        <span className="kl-msg-att-meta">{formatBytes(sizeBytes)}</span>
      )}
      {!cached && !platformUrl && (
        <span className="kl-msg-att-meta" title="Preview not cached on this device">
          (preview unavailable)
        </span>
      )}
    </>
  );
  if (platformUrl) {
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
  return (
    <div className={`kl-msg-att file${cached ? "" : " missing"}`}>
      {body}
    </div>
  );
}

function openPlatformFile(url: string) {
  return async (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    const signedUrl = await signedOpenUrl(url);
    window.open(signedUrl, "_blank", "noopener,noreferrer");
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
      const signedUrl = await signedOpenUrl(url);
      const response = await fetch(signedUrl);
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
      const signedUrl = await signedOpenUrl(url).catch(() => url);
      window.open(signedUrl, "_blank", "noopener,noreferrer");
    }
  };
}

async function signedOpenUrl(url: string): Promise<string> {
  const session = loadSession();
  if (!session?.accessToken) return url;
  const tokenUrl = `${url.replace(/[?#].*$/, "")}-token`;
  const response = await fetch(tokenUrl, {
    headers: { authorization: `Bearer ${session.accessToken}` },
  });
  if (!response.ok) return url;
  const payload = (await response.json()) as { openUrl?: unknown };
  if (typeof payload.openUrl !== "string" || !payload.openUrl) {
    return url;
  }
  return payload.openUrl;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
