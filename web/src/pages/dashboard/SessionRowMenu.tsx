import { useEffect, useRef } from "react";
import { Icons } from "../../components/Icons";

type SessionRowMenuProps = {
  anchor: HTMLElement;
  isPinned: boolean;
  isArchived: boolean;
  onPin: () => void;
  onRename: () => void;
  onArchive: () => void;
  onClose: () => void;
};

const MENU_WIDTH = 170;

export function SessionRowMenu({
  anchor,
  isPinned,
  isArchived,
  onPin,
  onRename,
  onArchive,
  onClose,
}: SessionRowMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target)) return;
      if (anchor.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchor, onClose]);

  const rect = anchor.getBoundingClientRect();
  const top = Math.min(window.innerHeight - 140, rect.bottom + 4);
  const left = Math.min(window.innerWidth - MENU_WIDTH - 8, rect.right - MENU_WIDTH);

  return (
    <div
      ref={ref}
      className="kl-row-menu"
      style={{ top, left, width: MENU_WIDTH }}
    >
      <div
        className="item"
        onClick={() => {
          onPin();
          onClose();
        }}
      >
        <Icons.Pin size={13} />
        <span>{isPinned ? "Unpin" : "Pin"}</span>
      </div>
      <div
        className="item"
        onClick={() => {
          onRename();
          onClose();
        }}
      >
        <Icons.Pencil size={13} />
        <span>Rename</span>
      </div>
      <div
        className="item"
        onClick={() => {
          onArchive();
          onClose();
        }}
      >
        <Icons.Archive size={13} />
        <span>{isArchived ? "Unarchive" : "Archive"}</span>
      </div>
    </div>
  );
}
