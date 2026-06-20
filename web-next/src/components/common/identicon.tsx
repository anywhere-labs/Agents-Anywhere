import type { CSSProperties } from "react";

function aaHash(value: string): number {
  let hash = 5381 >>> 0;
  for (let index = 0; index < value.length; index++) {
    hash = (((hash << 5) + hash) ^ value.charCodeAt(index)) >>> 0;
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b) >>> 0;
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
  hash ^= hash >>> 16;
  return hash >>> 0;
}

export interface IdenticonProps {
  id?: string;
  size?: number;
  shape?: "circle" | "rounded";
  className?: string;
  style?: CSSProperties;
}

export function Identicon({
  id = "user",
  size = 28,
  shape = "circle",
  className,
  style
}: IdenticonProps) {
  const hash = aaHash(String(id || "user"));
  const hue = hash % 360;
  const foreground = `oklch(0.62 0.11 ${hue})`;
  const background = `color-mix(in oklch, ${foreground} 14%, var(--bg-elev))`;
  const cells: boolean[] = [];

  for (let index = 0; index < 15; index++) {
    cells.push(((hash >>> (index + 4)) & 1) === 1);
  }

  const fillCount = cells.filter(Boolean).length;
  if (fillCount < 3 || fillCount > 12) {
    for (let row = 0; row < 5; row++) {
      cells[row * 3 + 2] = !cells[row * 3 + 2];
    }
  }

  return (
    <div
      className={className}
      style={{
        width: size,
        height: size,
        borderRadius:
          shape === "circle" ? "50%" : `${Math.max(4, Math.round(size * 0.22))}px`,
        background,
        padding: size * 0.16,
        boxSizing: "border-box",
        flexShrink: 0,
        display: "inline-block",
        lineHeight: 0,
        ...style
      }}
      aria-label={id ? `Avatar for ${id}` : "Avatar"}
      role="img"
    >
      <svg
        width="100%"
        height="100%"
        viewBox="0 0 5 5"
        preserveAspectRatio="none"
        style={{ display: "block" }}
      >
        {cells.map((enabled, index) => {
          if (!enabled) return null;
          const row = Math.floor(index / 3);
          const column = index % 3;
          const rects = [
            <rect
              key={`${index}a`}
              x={column}
              y={row}
              width={1.02}
              height={1.02}
              fill={foreground}
            />
          ];
          if (column !== 2) {
            rects.push(
              <rect
                key={`${index}b`}
                x={4 - column}
                y={row}
                width={1.02}
                height={1.02}
                fill={foreground}
              />
            );
          }
          return rects;
        })}
      </svg>
    </div>
  );
}
