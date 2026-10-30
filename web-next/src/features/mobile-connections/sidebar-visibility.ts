"use client"

import { createSidebarVisibility } from "../sidebar/sidebar-visibility"

const visibility = createSidebarVisibility(
  "aa-mobile-connections-sidebar-visible-v1",
  "aa:mobile-connections-sidebar-visibility",
)

export const useMobileConnectionsSidebarVisibility = visibility.useVisibility
export const setMobileConnectionsSidebarVisible = visibility.setVisible
