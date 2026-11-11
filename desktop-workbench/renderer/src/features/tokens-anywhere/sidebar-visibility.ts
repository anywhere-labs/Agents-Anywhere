"use client"

import { createSidebarVisibility } from "../sidebar/sidebar-visibility"

const visibility = createSidebarVisibility(
  "aa-tokens-anywhere-sidebar-visible-v1",
  "aa:tokens-anywhere-sidebar-visibility",
)

export const useTokensAnywhereSidebarVisibility = visibility.useVisibility
