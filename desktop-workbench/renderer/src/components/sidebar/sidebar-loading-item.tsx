import { SidebarMenuItem } from "@/components/ui/sidebar"
import { Spinner } from "@/components/ui/spinner"

export function SidebarLoadingItem({ label }: { label: string }) {
  return (
    <SidebarMenuItem>
      <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
        <Spinner className="size-3.5" />
        <span>{label}</span>
      </div>
    </SidebarMenuItem>
  )
}

