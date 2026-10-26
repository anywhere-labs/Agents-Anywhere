"use client"

// Adapted from shadcn/base-nova. Source hashes and AA changes: docs/code-block-rendering.md.
import * as React from "react"
import { Check, Copy, Loader2 } from "lucide-react"
import { cva, type VariantProps } from "class-variance-authority"

import { Button } from "@/components/ui/button"
import { copyText } from "@/lib/clipboard"
import { cn } from "@/lib/utils"

const codeBlockVariants = cva(
  "group/code-block relative min-w-0 max-w-full overflow-hidden",
  {
    variants: {
      presentation: {
        markdown: "my-3 rounded-xl border border-border bg-background",
        tool: "bg-background",
        pairing:
          "grid grid-cols-[minmax(0,1fr)_auto] rounded-lg border border-border bg-muted/40",
      },
      flush: { true: "", false: "rounded-xl border border-border" },
    },
  },
)

function CodeBlock({
  className,
  presentation = "markdown",
  flush,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof codeBlockVariants>) {
  return (
    <div
      data-slot="code-block"
      data-presentation={presentation}
      className={cn(codeBlockVariants({ presentation, flush }), className)}
      {...props}
    />
  )
}

function CodeBlockHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="code-block-header"
      className={cn(
        "flex h-9 min-w-0 items-center justify-between gap-2 border-b bg-muted/25 px-3",
        className,
      )}
      {...props}
    />
  )
}

function CodeBlockTitle({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="code-block-title"
      className={cn(
        "min-w-0 truncate text-xs text-muted-foreground",
        className,
      )}
      {...props}
    />
  )
}

function CodeBlockActions({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="code-block-actions"
      className={cn("flex shrink-0 items-center gap-1", className)}
      {...props}
    />
  )
}

type CopyButtonProps = Omit<React.ComponentProps<typeof Button>, "value"> & {
  value: string
  label: string
  copiedLabel: string
  onCopyError: () => void
  containerRef?: React.RefObject<HTMLDivElement | null>
  feedbackMs?: number
  presentation?: "header" | "pairing"
}

function CodeBlockCopyButton({
  value,
  label,
  copiedLabel,
  onCopyError,
  containerRef,
  feedbackMs = 1200,
  presentation = "header",
  className,
  disabled,
  onClick,
  ...props
}: CopyButtonProps) {
  const [copied, setCopied] = React.useState(false)
  const [copying, setCopying] = React.useState(false)
  const busy = React.useRef(false)
  const mounted = React.useRef(false)
  const revision = React.useRef(0)
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  React.useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  React.useEffect(() => {
    revision.current++
    setCopied(false)
    return () => {
      if (timer.current !== null) clearTimeout(timer.current)
    }
  }, [value])

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size={presentation === "pairing" ? "icon" : "icon-xs"}
        data-slot="code-block-copy-button"
        data-copied={copied || undefined}
        disabled={disabled || copying}
        aria-label={copied ? copiedLabel : label}
        aria-busy={copying || undefined}
        className={cn(
          "text-muted-foreground hover:bg-accent hover:text-foreground",
          presentation === "pairing"
            ? "m-2 self-center"
            : "size-[22px] rounded-md p-1 [&_svg:not([class*='size-'])]:size-3.5",
          className,
        )}
        onClick={async (event) => {
          onClick?.(event)
          if (event.defaultPrevented || busy.current) return
          busy.current = true
          const requestedRevision = revision.current
          if (timer.current !== null) clearTimeout(timer.current)
          setCopied(false)
          setCopying(true)
          try {
            await copyText(value, containerRef?.current ?? undefined)
            if (mounted.current && requestedRevision === revision.current) {
              setCopied(true)
              timer.current = setTimeout(() => setCopied(false), feedbackMs)
            }
          } catch {
            if (mounted.current) onCopyError()
          } finally {
            busy.current = false
            if (mounted.current) setCopying(false)
          }
        }}
        {...props}
      >
        {copying ? (
          <Loader2 className="animate-spin motion-reduce:animate-none" />
        ) : copied ? (
          <Check />
        ) : (
          <Copy />
        )}
      </Button>
      <span aria-live="polite" className="sr-only">
        {copied ? copiedLabel : ""}
      </span>
    </>
  )
}

function CodeBlockContent({
  className,
  children,
  style,
  wrap = false,
  lineNumbers = false,
  startLine = 1,
  externalScroll = false,
  presentation = "markdown",
  ...props
}: React.ComponentProps<"pre"> & {
  wrap?: boolean
  lineNumbers?: boolean
  startLine?: number
  externalScroll?: boolean
  presentation?: "markdown" | "tool" | "pairing"
}) {
  return (
    <pre
      data-slot="code-block-content"
      data-numbered={lineNumbers || undefined}
      dir="ltr"
      tabIndex={externalScroll ? -1 : 0}
      style={{ counterReset: `line ${startLine - 1}`, ...style }}
      className={cn(
        "m-0 w-max min-w-full whitespace-pre",
        externalScroll
          ? "overflow-visible"
          : "overflow-auto focus-visible:outline-2 focus-visible:outline-ring",
        presentation === "markdown"
          ? "p-3 text-sm leading-relaxed"
          : presentation === "tool"
            ? "code-mono px-3 py-2 text-xs leading-relaxed"
            : "code-mono px-4 py-3 text-xs leading-4 text-foreground",
        wrap && "w-full whitespace-pre-wrap wrap-break-word",
        className,
      )}
      {...props}
    >
      <code
        data-slot="code-block-code"
        className={cn(
          presentation === "pairing" && "block",
          lineNumbers && "grid grid-cols-[auto_1fr]",
        )}
      >
        {lineNumbers && typeof children === "string"
          ? children
              .split("\n")
              .map((line, index) => (
                <CodeBlockLine key={index}>{line}</CodeBlockLine>
              ))
          : children}
      </code>
    </pre>
  )
}

const lineVariants = cva(
  "relative block min-h-lh in-data-numbered:col-span-2 in-data-numbered:grid in-data-numbered:grid-cols-subgrid in-data-numbered:gap-x-3 in-data-numbered:[counter-increment:line] in-data-numbered:before:content-[counter(line)] in-data-numbered:supports-[content:counter(line)_/_'']:before:content-[counter(line)_/_''] before:select-none before:text-muted-foreground before:text-end",
  {
    variants: {
      variant: {
        default: "",
        added: "bg-muted",
        removed: "bg-destructive/10",
        highlighted: "bg-muted",
      },
    },
    defaultVariants: { variant: "default" },
  },
)

const CodeBlockLine = React.memo(function CodeBlockLine({
  className,
  variant,
  children,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof lineVariants>) {
  const empty =
    children === undefined ||
    children === null ||
    children === "" ||
    (Array.isArray(children) && children.length === 0)
  return (
    <span
      data-slot="code-block-line"
      data-variant={variant}
      className={cn(lineVariants({ variant }), className)}
      {...props}
    >
      {variant === "added" || variant === "removed" ? (
        <span aria-hidden="true" className="select-none">
          {variant === "added" ? "+" : "−"}
        </span>
      ) : null}
      {empty ? "\n" : children}
    </span>
  )
})

function CodeBlockFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="code-block-footer"
      className={cn(
        "flex min-w-0 items-center gap-2 px-3 pb-3 text-muted-foreground",
        className,
      )}
      {...props}
    />
  )
}

export {
  CodeBlock,
  CodeBlockHeader,
  CodeBlockTitle,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockContent,
  CodeBlockLine,
  CodeBlockFooter,
}
