import type { LucideIcon } from "lucide-react"

export interface NavItem {
  title: string
  href: string
  icon: LucideIcon
}

export interface NavGroup {
  label?: string
  items: NavItem[]
}

/** True when `pathname` is on `href` (or a child route, unless `href === home`). */
export function isActivePath(pathname: string, href: string, home: string): boolean {
  if (href === home) return pathname === home
  return pathname === href || pathname.startsWith(`${href}/`)
}
