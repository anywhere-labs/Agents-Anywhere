import { useEffect, useState } from "react";

import {
  getAttachment,
  isImageMediaType,
  urlForCached,
  type CachedAttachment,
} from "../../lib/attachmentCache";

export type AttachmentDescriptor = {
  fileId: string;
  name?: string;
  size?: number;
  mediaType?: string;
};

export function MessageAttachments({
  attachments,
}: {
  attachments: AttachmentDescriptor[];
}) {
  if (!attachments || attachments.length === 0) return null;
  return (
    <div className="kl-msg-attachments">
      {attachments.map((att) => (
        <AttachmentTile key={att.fileId} descriptor={att} />
      ))}
    </div>
  );
}

function AttachmentTile({ descriptor }: { descriptor: AttachmentDescriptor }) {
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

  if (cached === "loading") {
    // Skeleton placeholder — short enough that you barely see it but stable
    // height keeps the bubble from jumping when the IndexedDB read resolves.
    return <div className="kl-msg-att skeleton" aria-busy="true" />;
  }

  if (cached && isImage) {
    return (
      <a
        className="kl-msg-att image"
        href={urlForCached(cached)}
        target="_blank"
        rel="noreferrer"
        title={`${cached.name} · ${formatBytes(cached.size)}`}
      >
        <img src={urlForCached(cached)} alt={cached.name} />
      </a>
    );
  }

  // Non-image OR no IndexedDB hit (e.g. session opened in a different browser).
  // Show name + size. We don't auto-download from the server because backend
  // deletes user-uploaded files after the connector consumes them.
  return (
    <div className={`kl-msg-att file${cached ? "" : " missing"}`}>
      <span className="kl-msg-att-icon" aria-hidden="true">
        📎
      </span>
      <span className="kl-msg-att-name">{name ?? descriptor.fileId}</span>
      {typeof sizeBytes === "number" && (
        <span className="kl-msg-att-meta">{formatBytes(sizeBytes)}</span>
      )}
      {!cached && (
        <span className="kl-msg-att-meta" title="Preview not cached on this device">
          (preview unavailable)
        </span>
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
