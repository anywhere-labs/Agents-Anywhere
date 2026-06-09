import { useId, type CSSProperties, type ReactNode, type SVGProps } from "react";

type IconProps = {
  size?: number;
  className?: string;
  style?: CSSProperties;
};

type StrokeIconProps = IconProps & {
  children?: ReactNode;
  d?: string;
  strokeWidth?: number;
  fill?: SVGProps<SVGSVGElement>["fill"];
};

function StrokeIcon({
  size = 16,
  className,
  style,
  children,
  d,
  strokeWidth = 1.5,
  fill = "none",
}: StrokeIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden="true"
    >
      {d ? <path d={d} /> : children}
    </svg>
  );
}

export const Icons = {
  Plus: (p: IconProps) => <StrokeIcon {...p} d="M12 5v14M5 12h14" />,
  Search: (p: IconProps) => (
    <StrokeIcon {...p}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </StrokeIcon>
  ),
  Sidebar: (p: IconProps) => (
    <StrokeIcon {...p}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </StrokeIcon>
  ),
  X: (p: IconProps) => <StrokeIcon {...p} d="M6 6l12 12M18 6L6 18" />,
  More: (p: IconProps) => (
    <StrokeIcon {...p}>
      <circle cx="5" cy="12" r="1.2" fill="currentColor" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" />
      <circle cx="19" cy="12" r="1.2" fill="currentColor" />
    </StrokeIcon>
  ),
  Check: (p: IconProps) => <StrokeIcon {...p} d="m5 12 5 5 9-11" />,
  Hand: (p: IconProps) => (
    <StrokeIcon {...p}>
      <path d="M8 11V6.5a1.5 1.5 0 0 1 3 0V11" />
      <path d="M11 10V5.5a1.5 1.5 0 0 1 3 0V11" />
      <path d="M14 10.5V7a1.5 1.5 0 0 1 3 0v5" />
      <path d="M17 11.5v-1a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-1.5a6.5 6.5 0 0 1-5.2-2.6L4 15.4a1.7 1.7 0 0 1 2.6-2.2L9 15" />
    </StrokeIcon>
  ),
  Laptop: (p: IconProps) => (
    <StrokeIcon {...p}>
      <rect x="5" y="5" width="14" height="10" rx="1.5" />
      <path d="M3 19h18l-2-4H5z" />
    </StrokeIcon>
  ),
  ChevDown: (p: IconProps) => <StrokeIcon {...p} d="m6 9 6 6 6-6" />,
  ChevUp: (p: IconProps) => <StrokeIcon {...p} d="m6 15 6-6 6 6" />,
  ChevRight: (p: IconProps) => <StrokeIcon {...p} d="m9 6 6 6-6 6" />,
  Copy: (p: IconProps) => (
    <StrokeIcon {...p}>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </StrokeIcon>
  ),
  Pencil: (p: IconProps) => (
    <StrokeIcon {...p} d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
  ),
  Pin: (p: IconProps) => (
    <StrokeIcon {...p}>
      <path d="M12 17v5" />
      <path d="M9 3h6l1 6a4 4 0 0 1 2 4H6a4 4 0 0 1 2-4z" />
    </StrokeIcon>
  ),
  Archive: (p: IconProps) => (
    <StrokeIcon {...p}>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8M10 12h4" />
    </StrokeIcon>
  ),
  Trash: (p: IconProps) => (
    <StrokeIcon {...p}>
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="m6 6 1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14M10 11v6M14 11v6" />
    </StrokeIcon>
  ),
  Filter: (p: IconProps) => (
    <StrokeIcon {...p}>
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="18" x2="21" y2="18" />
      <circle cx="9" cy="6" r="2.2" fill="currentColor" strokeWidth={0} />
      <circle cx="15" cy="18" r="2.2" fill="currentColor" strokeWidth={0} />
    </StrokeIcon>
  ),
  Settings: (p: IconProps) => (
    <StrokeIcon {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </StrokeIcon>
  ),
  Globe: (p: IconProps) => (
    <StrokeIcon {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </StrokeIcon>
  ),
  GitHub: (p: IconProps) => (
    <svg
      width={p.size ?? 16}
      height={p.size ?? 16}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={p.className}
      style={p.style}
      aria-hidden="true"
    >
      <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.04 1.53 1.04.9 1.52 2.35 1.08 2.92.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.95 0-1.1.39-2 1.03-2.7-.1-.25-.45-1.28.1-2.66 0 0 .84-.27 2.75 1.03a9.5 9.5 0 0 1 5 0c1.9-1.3 2.75-1.03 2.75-1.03.55 1.38.2 2.41.1 2.66.64.7 1.02 1.6 1.02 2.7 0 3.85-2.34 4.7-4.57 4.95.36.31.68.92.68 1.86v2.76c0 .27.18.58.69.48A10 10 0 0 0 12 2z" />
    </svg>
  ),
  User: (p: IconProps) => (
    <StrokeIcon {...p}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </StrokeIcon>
  ),
  Users: (p: IconProps) => (
    <StrokeIcon {...p}>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2 21a7 7 0 0 1 14 0" />
      <path d="M16 4a3.5 3.5 0 0 1 0 7" />
      <path d="M22 21a6 6 0 0 0-5-5.9" />
    </StrokeIcon>
  ),
  UserPlus: (p: IconProps) => (
    <StrokeIcon {...p}>
      <circle cx="9" cy="8" r="4" />
      <path d="M2 21a7 7 0 0 1 14 0" />
      <path d="M19 8v6M16 11h6" />
    </StrokeIcon>
  ),
  Lock: (p: IconProps) => (
    <StrokeIcon {...p}>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </StrokeIcon>
  ),
  Unlock: (p: IconProps) => (
    <StrokeIcon {...p}>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 7.5-2" />
    </StrokeIcon>
  ),
  Key: (p: IconProps) => (
    <StrokeIcon {...p}>
      <circle cx="8" cy="15" r="4" />
      <path d="m11 12 9-9" />
      <path d="m17 5 3 3" />
      <path d="m14 8 3 3" />
    </StrokeIcon>
  ),
  Shield: (p: IconProps) => (
    <StrokeIcon {...p} d="M12 2 4 5v6c0 5 3.5 9.5 8 11 4.5-1.5 8-6 8-11V5z" />
  ),
  Slash: (p: IconProps) => (
    <StrokeIcon {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="m5.6 5.6 12.8 12.8" />
    </StrokeIcon>
  ),
  Eye: (p: IconProps) => (
    <StrokeIcon {...p}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </StrokeIcon>
  ),
  EyeOff: (p: IconProps) => (
    <StrokeIcon {...p}>
      <path d="M9.9 4.2A10.5 10.5 0 0 1 12 4c6.5 0 10 7 10 7a17 17 0 0 1-3.6 4.4M6.5 6.5C3.6 8.4 2 12 2 12s3.5 7 10 7c1.9 0 3.6-.4 5-1.2" />
      <path d="M14.1 14.1a3 3 0 1 1-4.2-4.2M3 3l18 18" />
    </StrokeIcon>
  ),
  AlertCircle: (p: IconProps) => (
    <StrokeIcon {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v4" />
      <circle cx="12" cy="16.5" r="0.5" fill="currentColor" />
    </StrokeIcon>
  ),
  Sun: (p: IconProps) => (
    <StrokeIcon {...p}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </StrokeIcon>
  ),
  Moon: (p: IconProps) => (
    <StrokeIcon {...p} d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
  ),
  Sparkle: (p: IconProps) => (
    <StrokeIcon
      {...p}
      d="m12 3 1.6 5.6L19 10l-5.4 1.4L12 17l-1.6-5.6L5 10l5.4-1.4z"
      fill="currentColor"
      strokeWidth={0}
    />
  ),
  Logout: (p: IconProps) => (
    <StrokeIcon {...p}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
    </StrokeIcon>
  ),
  Terminal: (p: IconProps) => (
    <StrokeIcon {...p}>
      <path d="m4 7 4 5-4 5" />
      <path d="M12 19h8" />
    </StrokeIcon>
  ),
  List: (p: IconProps) => (
    <StrokeIcon {...p}>
      <path d="M8 6h13M8 12h13M8 18h13" />
      <circle cx="4" cy="6" r="1" fill="currentColor" strokeWidth={0} />
      <circle cx="4" cy="12" r="1" fill="currentColor" strokeWidth={0} />
      <circle cx="4" cy="18" r="1" fill="currentColor" strokeWidth={0} />
    </StrokeIcon>
  ),
  Folder: (p: IconProps) => (
    <StrokeIcon {...p}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </StrokeIcon>
  ),
  FolderOpen: (p: IconProps) => (
    <StrokeIcon {...p}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v.5" />
      <path d="m3 9 1.5 9a2 2 0 0 0 2 1.5h12a2 2 0 0 0 2-1.5L22 11H6a2 2 0 0 0-2 1.5z" />
    </StrokeIcon>
  ),
  File: (p: IconProps) => (
    <StrokeIcon {...p}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </StrokeIcon>
  ),
  Files: (p: IconProps) => (
    <StrokeIcon {...p}>
      <path d="M14 2H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M4 6v14a2 2 0 0 0 2 2h11" />
    </StrokeIcon>
  ),
  Refresh: (p: IconProps) => (
    <StrokeIcon {...p}>
      <path d="M21 12a9 9 0 1 1-3.2-6.9" />
      <path d="M21 5v4h-4" />
    </StrokeIcon>
  ),
  External: (p: IconProps) => (
    <StrokeIcon {...p}>
      <path d="M14 3h7v7" />
      <path d="m21 3-9 9" />
      <path d="M12 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-6" />
    </StrokeIcon>
  ),
  Loader: (p: IconProps) => (
    <StrokeIcon {...p}>
      <path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8" />
    </StrokeIcon>
  ),
  ArrowUp: (p: IconProps) => <StrokeIcon {...p} d="M12 19V5M5 12l7-7 7 7" />,
  Download: (p: IconProps) => (
    <StrokeIcon {...p}>
      <path d="M12 3v11" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 21h14" />
    </StrokeIcon>
  ),
  Save: (p: IconProps) => (
    <StrokeIcon {...p}>
      <path d="M5 3h13l1 1v17H5z" />
      <path d="M8 3v6h9" />
      <path d="M8 21v-7h8v7" />
    </StrokeIcon>
  ),
  Paperclip: (p: IconProps) => (
    <StrokeIcon {...p} d="M21 11.5L12.5 20a5 5 0 0 1-7-7L14 4.5a3.5 3.5 0 0 1 5 5L10.5 18a2 2 0 0 1-3-3L15 7.5" />
  ),
  Mic: (p: IconProps) => (
    <StrokeIcon {...p}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </StrokeIcon>
  ),
  Stop: (p: IconProps) => (
    <StrokeIcon {...p}>
      <rect x="6" y="6" width="12" height="12" rx="1.5" />
    </StrokeIcon>
  ),
  GitBranch: (p: IconProps) => (
    <StrokeIcon {...p}>
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="7" r="2" />
      <path d="M6 7v10M8 7h4a4 4 0 0 1 4 4v0" />
    </StrokeIcon>
  ),
  Code: (p: IconProps) => (
    <StrokeIcon {...p} d="m8 6-6 6 6 6M16 6l6 6-6 6" />
  ),
  Clock: (p: IconProps) => (
    <StrokeIcon {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </StrokeIcon>
  ),
};

export function KlawMark({ size = 18, color }: { size?: number; color?: string }) {
  // Three claw scratches — curved, tapered, fading like a real swipe.
  const uid = useId().replace(/[:.]/g, "");
  const gid = `kw-grad-${uid}`;
  const style = {
    "--mk-size": `${size}px`,
    "--mk-color": color ?? "var(--accent)",
  } as CSSProperties;
  return (
    <span className="klaw-mark" style={style}>
      <svg viewBox="0 0 24 24" fill="none">
        <defs>
          <linearGradient
            id={gid}
            gradientUnits="userSpaceOnUse"
            x1="12"
            y1="1"
            x2="12"
            y2="22"
          >
            <stop offset="0%" stopColor="var(--mk-color)" stopOpacity="1" />
            <stop offset="55%" stopColor="var(--mk-color)" stopOpacity="0.85" />
            <stop offset="100%" stopColor="var(--mk-color)" stopOpacity="0.30" />
          </linearGradient>
        </defs>
        <path
          d="M 5.6 3.2 C 4.4 7.8, 3.6 12, 3.7 17.2"
          stroke={`url(#${gid})`}
          strokeWidth="1.7"
          strokeLinecap="round"
        />
        <path
          d="M 11.4 1.6 C 11.3 7.6, 10.4 14.4, 9.2 21.6"
          stroke={`url(#${gid})`}
          strokeWidth="2.15"
          strokeLinecap="round"
        />
        <path
          d="M 17.6 2.8 C 17.6 7.4, 17.1 12.6, 15.6 18.8"
          stroke={`url(#${gid})`}
          strokeWidth="1.85"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}
