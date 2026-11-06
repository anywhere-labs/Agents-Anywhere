"use client"

import { useWorkspace } from "@/components/workspace-context"
import { PRODUCT_LINKS } from "@/lib/product-links"

/**
 * Tokens Anywhere's origin: the address this instance's Server is set to,
 * so self-hosted instances work without a rebuild. Builds that still set
 * NEXT_PUBLIC_TOKENS_ANYWHERE_URL fall back to it until the snapshot arrives.
 */
export function useTokensAnywhereUrl(): string | null {
  const { modelConfig } = useWorkspace()
  const tokens = modelConfig?.tokens
  if (tokens) return tokens.available ? tokens.tokensUrl : null
  return PRODUCT_LINKS.tokensAnywhereUrl || null
}
