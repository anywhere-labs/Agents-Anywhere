"use client"

import * as React from "react"
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"

export function SettingsSection({
  title,
  description,
  action,
  children,
  footer,
  contentClassName,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
  children?: React.ReactNode
  footer?: React.ReactNode
  contentClassName?: string
}) {
  const titleId = React.useId()
  return (
    <Card variant="settings" role="region" aria-labelledby={titleId}>
      <CardHeader className="flex flex-wrap items-center justify-between gap-4 py-5">
        <div className="flex min-w-0 flex-1 basis-40 flex-col gap-0.5">
          <CardTitle id={titleId} role="heading" aria-level={2}>{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </div>
        {action ? <CardAction className="max-w-full self-center">{action}</CardAction> : null}
      </CardHeader>
      {children ? (
        <>
          <Separator />
          <CardContent className={cn("py-4", contentClassName)}>{children}</CardContent>
        </>
      ) : null}
      {footer ? <CardFooter className="flex-wrap gap-2 pb-5">{footer}</CardFooter> : null}
    </Card>
  )
}
