"use client"

// The admin console: anywhere-ui's console template (ConsoleShell — wordmark switcher, grouped nav, account switcher
// at the bottom), separate from the workbench. Only admins get in; everyone else goes back to the workbench.
import { ArrowLeftIcon, CloudIcon, LayoutDashboardIcon } from "lucide-react"
import { useRouter } from "next/navigation"
import { useEffect } from "react"

import { ConsoleShell } from "@/components/console/console-shell"
import { AccountSwitcher } from "@/components/console/console-sidebar"
import type { NavGroup } from "@/components/console/nav"
import { useI18n } from "@/components/i18n-provider"
import { FullPageSpinner } from "@/components/spinner"
import { SidebarMenu, SidebarMenuItem } from "@/components/ui/sidebar"
import { ADMIN_DRIVE, ADMIN_HOME } from "@/lib/admin/paths"
import { useWorkbench } from "@/lib/state/workbench-context"

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { t } = useI18n()
  const router = useRouter()
  const { ready, accounts, activeAccount, switchAccount, signOutAccount, signOutAllAccounts } = useWorkbench()
  const isAdmin = activeAccount?.user.role === "admin"

  useEffect(() => {
    if (!ready) return
    if (!activeAccount) router.replace("/sign-in")
    else if (!isAdmin) router.replace("/")
  }, [ready, activeAccount, isAdmin, router])

  if (!ready || !activeAccount || !isAdmin) return <FullPageSpinner label={t("common.loading")} />

  const nav: NavGroup[] = [
    {
      label: t("admin.navGroup"),
      items: [
        { title: t("admin.nav.overview"), href: ADMIN_HOME, icon: LayoutDashboardIcon },
        { title: t("admin.nav.drive"), href: ADMIN_DRIVE, icon: CloudIcon },
      ],
    },
  ]

  return (
    <ConsoleShell
      sectionKey="admin"
      badge={t("shell.adminConsole")}
      home={ADMIN_HOME}
      homeLabel={t("admin.nav.overview")}
      openNavigationLabel={t("shell.openNavigation")}
      switchLabel={t("shell.switchConsole")}
      destinations={[{ href: "/", title: t("admin.backToWorkbench"), icon: ArrowLeftIcon }]}
      nav={nav}
      footer={
        <SidebarMenu>
          <SidebarMenuItem>
            <AccountSwitcher
              accounts={accounts.map((a) => ({
                user: { id: a.accountId, display_name: a.user.display_name, email: a.user.email },
                active: a.accountId === activeAccount.accountId,
              }))}
              onSwitch={(id) => void switchAccount(id)}
              onAddAccount={() => router.push("/sign-in?add=1")}
              onSignOut={() => void signOutAccount()}
              onSignOutAll={accounts.length > 1 ? () => void signOutAllAccounts() : undefined}
              labels={{
                triggerAria: t("shell.switchAccount"),
                accountsHeading: t("shell.accountsLabel"),
                addAccount: t("shell.addAccount"),
                signOut: t("shell.signOut"),
                signOutAll: t("shell.signOutAll"),
              }}
            />
          </SidebarMenuItem>
        </SidebarMenu>
      }
    >
      {children}
    </ConsoleShell>
  )
}
