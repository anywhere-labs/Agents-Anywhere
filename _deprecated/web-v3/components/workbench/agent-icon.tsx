"use client"

// Each agent's own mark (`agent-marks.ts`), in one colour (currentColor) so it sits with the other icons; an agent
// without one (added by hand) gets its initial in a rounded square.
import type * as React from "react"

import { AGENT_MARKS, type AgentMark } from "@/components/workbench/agent-marks"
import { cn } from "@/lib/utils"

function markFor(agent: string): AgentMark | undefined {
  const id = agent.toLowerCase()
  if (Object.hasOwn(AGENT_MARKS, id)) return AGENT_MARKS[id]
  // Other ways the same agents are named in a Connector's own list.
  if (id.startsWith("claude")) return AGENT_MARKS.claude
  if (id.startsWith("codex")) return AGENT_MARKS.codex
  if (id.startsWith("antigravity") || id === "agy") return AGENT_MARKS.antigravity
  if (id.startsWith("pi-")) return AGENT_MARKS.pi
  return undefined
}

export function AgentIcon({
  agent,
  name,
  className,
  ...props
}: { agent: string; name?: string } & Omit<React.SVGProps<SVGSVGElement>, "name">) {
  const mark = markFor(agent)
  if (mark) {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox={mark.viewBox}
        fill="currentColor"
        aria-hidden="true"
        className={cn("size-4 shrink-0", className)}
        {...props}
      >
        {mark.shapes.map((shape, i) =>
          typeof shape === "string" ? (
            <path key={i} d={shape} />
          ) : (
            <path
              key={i}
              d={shape.d}
              fillRule={shape.evenOdd ? "evenodd" : undefined}
              opacity={shape.opacity}
              {...(shape.stroke
                ? { fill: "none", stroke: "currentColor", strokeWidth: shape.stroke, strokeLinecap: "round" as const, strokeLinejoin: "round" as const }
                : {})}
            />
          )
        )}
      </svg>
    )
  }
  const initial = (name || agent).trim().charAt(0).toUpperCase() || "?"
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={cn("size-4 shrink-0", className)}
      {...props}
    >
      <rect x="1.5" y="1.5" width="21" height="21" rx="6" fill="none" stroke="currentColor" strokeWidth="2" />
      <text x="12" y="16.6" textAnchor="middle" fontSize="13" fontWeight="600" fill="currentColor" fontFamily="inherit">
        {initial}
      </text>
    </svg>
  )
}
