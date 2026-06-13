import type { CSSProperties, ReactNode, SVGProps } from "react";

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
  Check: (p: IconProps) => <StrokeIcon {...p} d="m5 12 5 5 9-11" />,
  Folder: (p: IconProps) => (
    <StrokeIcon {...p}>
      <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z" />
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
  Settings: (p: IconProps) => (
    <StrokeIcon {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </StrokeIcon>
  ),
  Terminal: (p: IconProps) => (
    <StrokeIcon {...p}>
      <path d="m4 7 4 5-4 5" />
      <path d="M12 19h8" />
    </StrokeIcon>
  ),
};
