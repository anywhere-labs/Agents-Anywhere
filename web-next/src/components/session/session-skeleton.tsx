"use client"

import { Skeleton } from "@/components/ui/skeleton"

export function SessionSkeleton() {
  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
      <div className="mx-auto w-full max-w-4xl space-y-4 px-5 pb-44 pt-20">
        <SessionSkeletonInline />
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 px-4 pb-4 pt-2">
        <div className="mx-auto w-full max-w-3xl rounded-2xl border border-border bg-card/85 p-4 shadow-sm backdrop-blur-xl supports-backdrop-filter:bg-card/70">
          <div className="space-y-3">
            <Skeleton className="h-12 w-full" />
            <div className="flex items-center gap-2">
              <Skeleton className="size-8 rounded-xl" />
              <Skeleton className="h-8 w-28 rounded-xl" />
              <Skeleton className="h-8 w-36 rounded-xl" />
              <div className="flex-1" />
              <Skeleton className="h-8 w-24 rounded-xl" />
              <Skeleton className="size-8 rounded-full" />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export function SessionSkeletonInline() {
  return (
    <>
      <Skeleton className="h-20 w-2/3" />
      <Skeleton className="ml-auto h-16 w-1/2" />
      <Skeleton className="h-32 w-full" />
    </>
  )
}
