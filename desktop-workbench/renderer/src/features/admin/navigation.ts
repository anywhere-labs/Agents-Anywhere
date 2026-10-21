/**
 * Administration sections and how they map onto `#/admin/<section>`.
 *
 * The "data" group re-exposes the usage board tabs so the sidebar drives them;
 * "management" edits people and announcements; "service" splits the instance
 * configuration into one page per concern.
 */
export const adminDataSections = ["overview", "users", "usage", "devices", "quality"] as const
export const adminManagementSections = ["team", "announcements"] as const
export const adminServiceSections = ["service-general", "service-auth", "service-email", "service-info"] as const
export const adminSections = [...adminDataSections, ...adminManagementSections, ...adminServiceSections] as const

export type AdminDataSection = (typeof adminDataSections)[number]
export type AdminManagementSection = (typeof adminManagementSections)[number]
export type AdminServiceSection = (typeof adminServiceSections)[number]
export type AdminSection = (typeof adminSections)[number]

export const DEFAULT_ADMIN_SECTION: AdminSection = "overview"

export function isAdminSection(value: unknown): value is AdminSection {
  return typeof value === "string" && (adminSections as readonly string[]).includes(value)
}

export function parseAdminSection(value: string | undefined): AdminSection {
  return isAdminSection(value) ? value : DEFAULT_ADMIN_SECTION
}

export function isAdminDataSection(section: AdminSection): section is AdminDataSection {
  return (adminDataSections as readonly string[]).includes(section)
}

export function isAdminServiceSection(section: AdminSection): section is AdminServiceSection {
  return (adminServiceSections as readonly string[]).includes(section)
}

/** The service page a `service-*` section shows: `service-auth` -> `auth`. */
export type ServicePageKey = "general" | "auth" | "email" | "info"

export function servicePageKey(section: AdminServiceSection): ServicePageKey {
  return section.slice("service-".length) as ServicePageKey
}

/** Routes that predate `#/admin/*` and still open the matching section. */
export const legacyAdminRoutes: Record<string, AdminSection> = {
  dashboard: "overview",
  team: "team",
  service: "service-general",
}

export const adminNavigation = [
  { group: "data", sections: adminDataSections },
  { group: "management", sections: adminManagementSections },
  { group: "service", sections: adminServiceSections },
] as const
