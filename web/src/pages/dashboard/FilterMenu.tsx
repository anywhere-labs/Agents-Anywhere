import { useEffect, useRef, useState } from "react";
import { Icons } from "../../components/Icons";

export type FilterKey = "device" | "agent" | "status" | "workspace";

export type FilterState = Record<FilterKey, string>;

export const FILTER_DEFAULTS: FilterState = {
  device: "all",
  agent: "all",
  status: "active",
  workspace: "all",
};

export type FilterOption = { value: string; label: string };

type FilterMenuProps = {
  anchor: HTMLElement | null;
  filters: FilterState;
  options: Record<FilterKey, FilterOption[]>;
  onChange: (key: FilterKey, value: string) => void;
  onReset: () => void;
  onClose: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
};

const LABELS: Record<FilterKey, string> = {
  device: "Device",
  agent: "Agent",
  status: "Status",
  workspace: "Workspace",
};

const ORDER: FilterKey[] = ["device", "agent", "status", "workspace"];

export function FilterMenu({
  anchor,
  filters,
  options,
  onChange,
  onReset,
  onClose,
  onMouseEnter,
  onMouseLeave,
}: FilterMenuProps) {
  const [submenu, setSubmenu] = useState<FilterKey | null>(null);
  const mainRef = useRef<HTMLDivElement | null>(null);
  const subRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef<Partial<Record<FilterKey, HTMLDivElement | null>>>({});
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const openSub = (k: FilterKey) => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setSubmenu(k);
  };
  const closeSubSoon = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setSubmenu(null), 140);
  };

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (mainRef.current?.contains(t)) return;
      if (subRef.current?.contains(t)) return;
      if (anchor?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (submenu) setSubmenu(null);
        else onClose();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, [anchor, onClose, submenu]);

  if (!anchor) return null;
  const rect = anchor.getBoundingClientRect();
  const W = 230;
  const top = Math.min(window.innerHeight - 280, rect.top - 4);
  const left = Math.min(window.innerWidth - W - 8, rect.right + 6);

  const isDefault = (k: FilterKey) => filters[k] === FILTER_DEFAULTS[k];
  const valLabel = (k: FilterKey) =>
    options[k].find((o) => o.value === filters[k])?.label ?? filters[k];
  const anySet = ORDER.some((k) => !isDefault(k));

  const SUBW = 200;
  let subTop = 0;
  let subLeft = 0;
  if (submenu && rowRefs.current[submenu]) {
    const r = rowRefs.current[submenu]!.getBoundingClientRect();
    subTop = Math.min(window.innerHeight - 240, r.top - 4);
    subLeft = Math.min(window.innerWidth - SUBW - 8, r.right + 6);
  }

  return (
    <>
      <div
        ref={mainRef}
        className="kl-filter-pop"
        style={{ top, left, width: W }}
        onMouseEnter={onMouseEnter}
        onMouseLeave={() => {
          closeSubSoon();
          onMouseLeave?.();
        }}
      >
        {ORDER.map((k) => (
          <div
            key={k}
            ref={(el) => {
              rowRefs.current[k] = el;
            }}
            className={`kl-filter-row${submenu === k ? " active" : ""}`}
            onMouseEnter={() => openSub(k)}
          >
            <span className="lbl">{LABELS[k]}</span>
            <span className={`val${isDefault(k) ? "" : " set"}`}>
              {valLabel(k)}
            </span>
            <span className="chev">
              <Icons.ChevRight size={11} />
            </span>
          </div>
        ))}
        {anySet && (
          <>
            <div className="kl-filter-sep" />
            <div
              className="kl-filter-row"
              onMouseEnter={() => setSubmenu(null)}
              onClick={() => {
                onReset();
                setSubmenu(null);
              }}
            >
              <span
                className="lbl"
                style={{ color: "var(--text-mut)", fontWeight: 400 }}
              >
                Clear filters
              </span>
            </div>
          </>
        )}
      </div>
      {submenu && (
        <div
          ref={subRef}
          className="kl-filter-pop"
          style={{ top: subTop, left: subLeft, width: SUBW }}
          onMouseEnter={() => {
            if (closeTimer.current) clearTimeout(closeTimer.current);
            onMouseEnter?.();
          }}
          onMouseLeave={() => {
            closeSubSoon();
            onMouseLeave?.();
          }}
        >
          {options[submenu].map((o) => (
            <div
              key={o.value}
              className={`kl-filter-opt${filters[submenu] === o.value ? " on" : ""}`}
              onClick={() => {
                onChange(submenu, o.value);
                setSubmenu(null);
              }}
            >
              <span className="check">
                <Icons.Check size={11} />
              </span>
              <span>{o.label}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
