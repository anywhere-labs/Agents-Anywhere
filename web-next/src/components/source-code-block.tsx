"use client"

import * as React from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  CodeBlock,
  CodeBlockHeader,
  CodeBlockTitle,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockContent,
} from "@/components/ui/code-block"
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area"
import { highlightCode } from "@/lib/code-highlight"
import { cn } from "@/lib/utils"

// Copy feedback and unrelated parent updates must not repeat tokenization.
const HighlightedCode = React.memo(function HighlightedCode({
  code,
  language,
}: {
  code: string
  language: string
}) {
  return React.useMemo(() => highlightCode(code, language), [code, language])
})

type Presentation = "markdown" | "tool" | "pairing"

export const SourceCodeContent = React.memo(function SourceCodeContent({
  code,
  language = "text",
  presentation = "markdown",
  maxHeight,
}: {
  code: string
  language?: string
  presentation?: Presentation
  maxHeight?: number
}) {
  return (
    <ScrollArea
      contentWide
      className="min-w-0 max-w-full overflow-hidden"
      style={
        maxHeight === undefined ? undefined : { height: maxHeight, maxHeight }
      }
      viewportProps={{
        tabIndex: 0,
        className: presentation === "markdown" ? "max-h-96" : undefined,
      }}
    >
      <CodeBlockContent externalScroll presentation={presentation}>
        {presentation === "pairing" ? (
          code
        ) : (
          <HighlightedCode code={code} language={language} />
        )}
      </CodeBlockContent>
      <ScrollBar orientation="horizontal" />
    </ScrollArea>
  )
})

export function SourceCodeBlock({
  code,
  language = "text",
  label,
  presentation = "markdown",
  maxHeight,
  flush,
  action,
  children,
  copyLabel,
}: {
  code: string
  language?: string
  label?: string
  presentation?: Presentation
  maxHeight?: number
  flush?: boolean
  action?: React.ReactNode
  children?: React.ReactNode
  copyLabel?: string
}) {
  const tCommon = useTranslations("common")
  const tSession = useTranslations("dashboard.session")
  const tPair = useTranslations("dashboard.pairDevice")
  const containerRef = React.useRef<HTMLDivElement>(null)
  const pairing = presentation === "pairing"
  const copy = (
    <CodeBlockCopyButton
      value={code}
      label={copyLabel ?? tSession("copyCode")}
      copiedLabel={tCommon("copied")}
      onCopyError={() =>
        toast.error(
          pairing ? tPair("errors.copyFailed") : tCommon("copyFailed"),
        )
      }
      containerRef={containerRef}
      presentation={pairing ? "pairing" : "header"}
      feedbackMs={pairing ? 2000 : 1200}
    />
  )
  const content = children ?? (
    <SourceCodeContent
      code={code}
      language={language}
      presentation={presentation}
      maxHeight={maxHeight}
    />
  )
  return (
    <CodeBlock
      ref={containerRef}
      presentation={presentation}
      flush={presentation === "tool" ? Boolean(flush) : undefined}
    >
      {pairing ? (
        <>
          {content}
          {copy}
        </>
      ) : (
        <>
          <CodeBlockHeader>
            <CodeBlockTitle
              className={cn(presentation === "tool" && "code-mono")}
            >
              {label ?? language}
            </CodeBlockTitle>
            <CodeBlockActions>
              {action}
              {copy}
            </CodeBlockActions>
          </CodeBlockHeader>
          {content}
        </>
      )}
    </CodeBlock>
  )
}
