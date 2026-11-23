import type * as React from "react"

/**
 * Orches' mark: a ring of three nodes, the agents it directs, with the ring broken around each one. Drawn on lucide's
 * 24px grid with its stroke and caps so it sits with the other icons; the nodes are filled so they still read at 16px.
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
      <path d="M15.18 4.12A8.5 8.5 0 0 1 20.42 13.18" />
      <path d="M17.23 18.7A8.5 8.5 0 0 1 6.77 18.7" />
      <path d="M3.58 13.18A8.5 8.5 0 0 1 8.82 4.12" />
      <circle cx="12" cy="3.5" r="2" fill="currentColor" stroke="none" />
      <circle cx="19.36" cy="16.25" r="2" fill="currentColor" stroke="none" />
      <circle cx="4.64" cy="16.25" r="2" fill="currentColor" stroke="none" />
    </svg>
  )
}
