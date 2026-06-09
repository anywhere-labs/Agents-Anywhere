import { useEffect } from "react";

type ConfirmModalProps = {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

export function ConfirmModal({
  title,
  body,
  confirmLabel,
  danger,
  onCancel,
  onConfirm,
}: ConfirmModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
      if (e.key === "Enter") {
        e.preventDefault();
        onConfirm();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel, onConfirm]);

  return (
    <div className="kl-modal-backdrop" onClick={onCancel}>
      <div
        className="kl-modal kl-confirm"
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
      >
        <h3>{title}</h3>
        <p>{body}</p>
        <div className="kl-modal-actions">
          <button type="button" className="kl-btn ghost" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={"kl-btn " + (danger ? "danger" : "primary")}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
