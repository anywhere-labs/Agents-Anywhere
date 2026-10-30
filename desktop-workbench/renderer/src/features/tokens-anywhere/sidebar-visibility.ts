"use client"

import { PRODUCT_LINKS } from "@/lib/product-links"

import { createSidebarVisibility } from "../sidebar/sidebar-visibility"

const visibility = createSidebarVisibility(
  "aa-tokens-anywhere-sidebar-visible-v1",
  "aa:tokens-anywhere-sidebar-visibility",
)

export const useTokensAnywhereSidebarVisibility = visibility.useVisibility

/** Builds without Tokens Anywhere's address show neither the entry nor its setting. */
export const tokensAnywhereAvailable = Boolean(PRODUCT_LINKS.tokensAnywhereUrl)
