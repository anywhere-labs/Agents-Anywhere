import { Suspense } from "react"

import { MobileOAuthPage } from "@/components/auth/mobile-oauth-page"

export default function MobileOAuthRoute() {
  return (
    <Suspense fallback={null}>
      <MobileOAuthPage />
    </Suspense>
  )
}
