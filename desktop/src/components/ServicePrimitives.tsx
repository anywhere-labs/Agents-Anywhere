import type { ReactNode } from "react";

export function ServiceHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="aa-srv-h">
      <h1>{title}</h1>
      <p>{subtitle}</p>
    </div>
  );
}

export function ServiceCard({
  title,
  actions,
  children,
  className,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={["aa-srv-card", className].filter(Boolean).join(" ")}>
      <div className="hd">
        <h3>{title}</h3>
        {actions}
      </div>
      <div className="body">{children}</div>
    </div>
  );
}

export function ServiceRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="aa-srv-row">
      <span className="k">{label}</span>
      <span className="v">{value}</span>
      <span />
    </div>
  );
}

export function ServiceToggle({
  title,
  subtitle,
  badge,
  checked,
  onChange,
}: {
  title: string;
  subtitle: string;
  badge?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="aa-srv-toggle">
      <div className="info">
        <span className="t">
          {title}
          {badge}
        </span>
        <span className="s">{subtitle}</span>
      </div>
      <label className="aa-srv-switch">
        <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
        <span className="track" />
        <span className="knob" />
      </label>
    </div>
  );
}

export function ServiceActions({ children }: { children: ReactNode }) {
  return <div className="aa-srv-actions">{children}</div>;
}
