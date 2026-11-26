import type * as React from "react"

/**
 * Orches' mark: two open orbits, one inside the other, both open toward the top right where a satellite sits — the
 * agents Orches keeps in motion. Drawn on lucide's 24px grid with its stroke and caps so it sits with the other icons;
 * the satellite is filled so it still reads at 16px.
 */
export function OrchesIcon({ className, strokeWidth = 2, ...props }: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      {...props}
    >
      <path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5" />
      <path d="M12 8a4 4 0 1 0 4 4" />
      <circle cx="19" cy="5" r="2" fill="currentColor" stroke="none" />
    </svg>
  )
}
