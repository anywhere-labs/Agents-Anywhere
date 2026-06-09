type Props = {
  filename: string;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
};

/** Three-action dialog: "Save / Discard / Cancel". Shown when the user
 * tries to close a dirty file preview. Focus traps to the Save button so
 * Enter saves and Escape cancels. */
export function UnsavedChangesDialog({ filename, onSave, onDiscard, onCancel }: Props) {
  return (
    <div
      className="kl-unsaved-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="kl-unsaved-title"
      onClick={onCancel}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
    >
      <div className="kl-unsaved" onClick={(e) => e.stopPropagation()}>
        <h3 id="kl-unsaved-title">Save changes to {filename}?</h3>
        <p>Unsaved changes will be lost if you close this preview.</p>
        <div className="kl-unsaved-actions">
          <button className="kl-btn ghost" onClick={onCancel}>
            Cancel
          </button>
          <button className="kl-btn ghost kl-discard" onClick={onDiscard}>
            Discard
          </button>
          <button className="kl-btn primary" autoFocus onClick={onSave}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
