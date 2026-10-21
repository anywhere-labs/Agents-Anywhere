"use client"

import { AnnouncementsPage } from "@/components/admin/announcements-page"
import { useAuth } from "@/components/auth/auth-context"
import { OpsDashboardPage } from "@/components/ops-dashboard/ops-dashboard-page"
import { ServicePage } from "@/components/pages/service-page"
import { TeamPage } from "@/components/pages/team-page"
import { useWorkspace } from "@/components/workspace-context"
import { isAdminDataSection, isAdminServiceSection } from "@/features/admin/navigation"

/** Renders the administration section named by the route; admins only. */
export function AdminPage() {
  const { me } = useAuth()
  const { adminSection } = useWorkspace()
  if (me?.role !== "admin") return null
  if (isAdminDataSection(adminSection)) return <OpsDashboardPage tab={adminSection} />
  if (isAdminServiceSection(adminSection)) return <ServicePage section={adminSection} />
  if (adminSection === "team") return <TeamPage />
  return <AnnouncementsPage />
}
