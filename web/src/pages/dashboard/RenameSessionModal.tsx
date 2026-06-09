import { useEffect, useRef, useState } from "react";

type RenameSessionModalProps = {
  initial: string;
  onCancel: () => void;
  onSave: (title: string) => void;
};

export function RenameSessionModal({
  initial,
  onCancel,
  onSave,
}: RenameSessionModalProps) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const trimmed = value.trim();
  const canSave = trimmed.length > 0 && trimmed !== initial.trim();

  const submit = () => {
    if (canSave) onSave(trimmed);
  };

  return (
    <div className="kl-modal-backdrop" onClick={onCancel}>
      <div className="kl-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Rename session</h3>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") onCancel();
          }}
        />
        <div className="kl-modal-actions">
          <button type="button" className="kl-btn ghost" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="kl-btn primary"
            onClick={submit}
            disabled={!canSave}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
