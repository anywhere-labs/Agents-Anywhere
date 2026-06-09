import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

type RuntimeWindowProps = {
  title: string;
  children: ReactNode;
  onClose: () => void;
};

export function RuntimeWindow({ title, children, onClose }: RuntimeWindowProps) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [popupBlocked, setPopupBlocked] = useState(false);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const child = window.open("", "_blank", "width=980,height=720");
    if (!child) {
      setPopupBlocked(true);
      return;
    }

    try {
      child.document.open();
      child.document.write(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"></head><body></body></html>",
      );
      child.document.close();
      child.document.title = title;

      const theme = document.documentElement.dataset.theme;
      if (theme) child.document.documentElement.dataset.theme = theme;

      copyRuntimeStyles(child);

      const root = child.document.createElement("div");
      root.className = "kl-runtime-popup-root";
      child.document.body.append(root);
      setContainer(root);
    } catch {
      if (!child.closed) child.close();
      setPopupBlocked(true);
      return;
    }

    const timer = window.setInterval(() => {
      if (child.closed) {
        window.clearInterval(timer);
        onCloseRef.current();
      }
    }, 500);

    return () => {
      window.clearInterval(timer);
      if (!child.closed) child.close();
    };
  }, [title]);

  const blockedModal = popupBlocked
    ? createPortal(
        <PopupBlockedModal
          title={title}
          onClose={() => {
            setPopupBlocked(false);
            onCloseRef.current();
          }}
        />,
        document.body,
      )
    : null;

  return (
    <>
      {container ? createPortal(children, container) : null}
      {blockedModal}
    </>
  );
}

function PopupBlockedModal({
  title,
  onClose,
}: {
  title: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Enter") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="kl-modal-backdrop" onClick={onClose}>
      <div
        className="kl-modal kl-confirm"
        onClick={(event) => event.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
      >
        <h3>Pop-ups are blocked</h3>
        <p>
          {title} needs a pop-up window. Allow pop-ups for this site, then open
          it again.
        </p>
        <div className="kl-modal-actions">
          <button type="button" className="kl-btn primary" onClick={onClose}>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

function copyRuntimeStyles(child: Window) {
  for (const stylesheet of Array.from(document.styleSheets)) {
    try {
      if (stylesheet.href) {
        const link = child.document.createElement("link");
        link.rel = "stylesheet";
        link.href = stylesheet.href;
        child.document.head.append(link);
        continue;
      }
      const rules = Array.from(stylesheet.cssRules)
        .map((rule) => rule.cssText)
        .join("\n");
      if (!rules) continue;
      const style = child.document.createElement("style");
      style.textContent = rules;
      child.document.head.append(style);
    } catch {
      // Cross-origin sheets cannot expose cssRules. Ignore them; app
      // styles are same-origin or inline in dev.
    }
  }

  const style = child.document.createElement("style");
  style.textContent = `
    html,
    body,
    .kl-runtime-popup-root {
      margin: 0;
      width: 100%;
      height: 100%;
      background: var(--bg, #0b0b0d);
      color: var(--text, #f4f4f5);
      overflow: hidden;
    }
    .kl-runtime-popup-root {
      display: flex;
      box-sizing: border-box;
      padding: 10px;
    }
    .kl-runtime-popup-root > .kl-rt-pane {
      flex: 1 1 0;
      min-width: 0;
      min-height: 0;
    }
  `;
  child.document.head.append(style);
}
