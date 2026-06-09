import type { CSSProperties } from "react";

// 5×5 mirrored geometric identicon, port of ui-design-source-code/project/identicon.jsx.
// Each user id hashes into a hue and a 5×3 bit grid that gets mirrored to a 5×5 pattern.

function aaHash(s: string): number {
  let h = 5381 >>> 0;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

type IdenticonProps = {
  id?: string;
  size?: number;
  shape?: "circle" | "rounded";
  className?: string;
  style?: CSSProperties;
};

export function Identicon({
  id = "user",
  size = 28,
  shape = "circle",
  className,
  style,
}: IdenticonProps) {
  const h = aaHash(String(id || "user"));
  const hue = h % 360;
  const fg = `oklch(0.62 0.11 ${hue})`;
  const bg = `color-mix(in oklch, ${fg} 14%, var(--bg-elev))`;

  const cells: boolean[] = [];
  for (let i = 0; i < 15; i++) cells.push(((h >>> (i + 4)) & 1) === 1);

  const fillCount = cells.filter(Boolean).length;
  if (fillCount < 3 || fillCount > 12) {
    for (let r = 0; r < 5; r++) cells[r * 3 + 2] = !cells[r * 3 + 2];
  }

  const radius =
    shape === "circle" ? "50%" : `${Math.max(4, Math.round(size * 0.22))}px`;
  const pad = size * 0.16;

  return (
    <div
      className={`aa-iden${className ? ` ${className}` : ""}`}
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: bg,
        padding: pad,
        boxSizing: "border-box",
        flexShrink: 0,
        display: "inline-block",
        lineHeight: 0,
        ...style,
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
        {cells.map((on, i) => {
          if (!on) return null;
          const r = Math.floor(i / 3);
          const c = i % 3;
          const out = [
            <rect key={`${i}a`} x={c} y={r} width={1.02} height={1.02} fill={fg} />,
          ];
          if (c !== 2) {
            out.push(
              <rect
                key={`${i}b`}
                x={4 - c}
                y={r}
                width={1.02}
                height={1.02}
                fill={fg}
              />,
            );
          }
          return out;
        })}
      </svg>
    </div>
  );
}
