import type { ReactNode } from "react"
import { Wordmark } from "@/components/onboarding/reference/components/wordmark"
import { cn } from "@/components/onboarding/reference/lib/utils"

export function OnboardingShell({ children, artwork, wordmark = true }: { children: ReactNode; artwork?: "phone" | "desktop"; wordmark?: boolean }) {
  return (
    <div className={cn("onboarding-shell", artwork === "desktop" && "onboarding-shell-desktop")}>
      <header className="flex min-h-[68px] items-center px-8 py-5">
        {wordmark ? <Wordmark /> : null}
      </header>
      <div className="onboarding-body">
        <main className={cn("onboarding-main", artwork && "onboarding-main-artwork")}>{children}</main>
      </div>
    </div>
  )
}
