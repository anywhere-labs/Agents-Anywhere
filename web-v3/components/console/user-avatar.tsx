import { cn } from "@/lib/utils"

/** The account's picture, or its initial in a borderless circle. */
export function UserAvatar({
  user,
  className,
}: {
  user:
    | { display_name?: string | null; email?: string | null; avatar?: string | null }
    | null
    | undefined
  className?: string
}) {
  const name = user?.display_name || user?.email || ""
  if (user?.avatar) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- external or data: URL
      <img
        data-slot="user-avatar"
        src={user.avatar}
        alt=""
        aria-hidden="true"
        className={cn(
          "inline-flex size-6 shrink-0 rounded-full bg-surface-raised object-cover",
          className
        )}
      />
    )
  }
  return (
    <span
      data-slot="user-avatar"
      aria-hidden="true"
      className={cn(
        "inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-raised text-xs font-medium text-foreground-secondary uppercase",
        className
      )}
    >
      {name.slice(0, 1)}
    </span>
  )
}
