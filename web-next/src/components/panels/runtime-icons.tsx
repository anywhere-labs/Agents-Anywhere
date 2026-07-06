import * as React from "react"

function PanelStrokeIcon({
  className = "size-4",
  children,
  ...props
}: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  )
}

export function PanelTerminalIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <PanelStrokeIcon {...props}>
      <path d="m4 7 4 5-4 5" />
      <path d="M12 19h8" />
    </PanelStrokeIcon>
  )
}

export function PanelFilesIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <PanelStrokeIcon {...props}>
      <path d="M14 2H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M4 6v14a2 2 0 0 0 2 2h11" />
    </PanelStrokeIcon>
  )
}

export function ChevronExternal({ className = "size-3.5", ...props }: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...props}
    >
      <path d="M7 17 17 7" />
      <path d="M9 7h8v8" />
    </svg>
  )
}
