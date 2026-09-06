"use client"

import * as React from "react"
import { ChevronDown, ChevronUp, FileDiff } from "lucide-react"
import { useTranslations } from "next-intl"

import type { ChangedTurnReview, ReviewFileChange } from "@/components/session/session-review-model"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"

const VISIBLE_FILE_COUNT = 3

export function SessionReviewCard({
  review,
  onReview,
}: {
  review: ChangedTurnReview
  onReview: () => void
}) {
  const t = useTranslations("dashboard.session.tools")
  const [expanded, setExpanded] = React.useState(false)
  const { files } = review
  const additions = files.reduce((total, file) => total + file.additions, 0)
  const deletions = files.reduce((total, file) => total + file.deletions, 0)
  const remainingFiles = files.slice(VISIBLE_FILE_COUNT)

  if (files.length === 0) return null

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded} asChild>
      <Card size="sm" className="gap-0 rounded-xl border py-0 shadow-none">
        <CardHeader className="flex flex-row items-center gap-2 rounded-t-none border-b bg-muted/40 px-3 py-2 [.border-b]:pb-2">
          <FileDiff className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
            <CardTitle className="text-sm">{t("reviewFilesEdited", { count: files.length })}</CardTitle>
            <CardDescription className="text-xs">
              <LineCounts additions={additions} deletions={deletions} />
            </CardDescription>
          </div>
          <CardAction className="self-center">
            <Button type="button" variant="outline" size="sm" className="rounded-lg" onClick={onReview}>
              {t("review")}
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="p-0">
          <FileRows files={files.slice(0, VISIBLE_FILE_COUNT)} />
          {remainingFiles.length > 0 ? (
            <CollapsibleContent>
              <FileRows files={remainingFiles} />
            </CollapsibleContent>
          ) : null}
        </CardContent>
        {remainingFiles.length > 0 ? (
          <CardFooter className="rounded-b-none bg-muted/40 p-0">
            <CollapsibleTrigger asChild>
              <Button type="button" variant="ghost" className="h-auto w-full justify-start gap-2 rounded-none px-3 py-2">
                {expanded ? t("reviewCollapseFiles") : t("reviewShowMoreFiles", { count: remainingFiles.length })}
                {expanded ? <ChevronUp data-icon="inline-end" /> : <ChevronDown data-icon="inline-end" />}
              </Button>
            </CollapsibleTrigger>
          </CardFooter>
        ) : null}
      </Card>
    </Collapsible>
  )
}

function FileRows({ files }: { files: ReviewFileChange[] }) {
  return (
    <ul>
      {files.map((file) => {
        const nameStart = file.displayPath.lastIndexOf("/") + 1
        return (
          <li key={file.path} className="code-mono flex min-h-8 items-center justify-between gap-3 px-3 py-1.5 text-xs">
            <span className="min-w-0 truncate text-muted-foreground" title={file.displayPath}>
              {file.displayPath.slice(0, nameStart)}
              <span className="text-foreground">{file.displayPath.slice(nameStart)}</span>
            </span>
            <LineCounts additions={file.additions} deletions={file.deletions} />
          </li>
        )
      })}
    </ul>
  )
}

function LineCounts({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="inline-flex shrink-0 gap-1 tabular-nums">
      <span className="text-emerald-600 dark:text-emerald-400">+{additions}</span>
      <span className="text-red-600 dark:text-red-400">-{deletions}</span>
    </span>
  )
}
