import type { CSSProperties, ReactNode } from "react"
import { cn } from "@/components/onboarding/reference/lib/utils"

const groupDuration = 400
const groupInterval = 130

function groupText(text: string) {
  const groups: string[] = []
  for (const [lineIndex, line] of text.split("\n").entries()) {
    if (lineIndex > 0) groups.push("\n")
    const phrases = line.match(/[^，。！？、：；,.!?;:]+[，。！？、：；,.!?;:]*/gu) ?? [line]
    let group = ""
    for (const phrase of phrases) {
      group += phrase
      // Keep short clauses together, so phrases such as "你，尽管自由。"
      // appear as one unit instead of revealing individual characters.
      if (Array.from(group.trim()).length >= 6) {
        groups.push(group)
        group = ""
      }
    }
    if (group) groups.push(group)
  }
  return groups
}

export function revealEnd(text: string, delay = 0) {
  const count = groupText(text).filter((group) => group.trim()).length
  return delay + Math.max(0, count - 1) * groupInterval + groupDuration
}

type RevealTextProps = {
  text: string
  as?: "h1" | "p"
  id?: string
  className?: string
  delay?: number
  suffix?: ReactNode
}

export function RevealText({ text, as: Tag = "p", id, className, delay = 0, suffix }: RevealTextProps) {
  let index = 0

  return (
    <Tag
      id={id} className={cn("reveal-text", className)} tabIndex={Tag === "h1" ? -1 : undefined}
      style={{ "--reveal-duration": `${groupDuration}ms` } as CSSProperties}
    >
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {groupText(text).map((group, position) => {
          if (group === "\n") return <br key={position} />
          if (!group.trim()) return group
          const style = { "--reveal-delay": `${delay + index++ * groupInterval}ms` } as CSSProperties
          return <span key={position} className="reveal-group" style={style}>{group}</span>
        })}
      </span>
      {suffix && (
        <span className="reveal-suffix reveal-detail" aria-hidden="true" style={{ "--reveal-delay": `${revealEnd(text, delay) + 100}ms` } as CSSProperties}>
          {suffix}
        </span>
      )}
    </Tag>
  )
}
