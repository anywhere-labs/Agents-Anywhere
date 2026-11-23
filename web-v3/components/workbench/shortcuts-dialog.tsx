"use client"

// The keyboard shortcuts, in one sheet (⌘/ as in ChatGPT and Claude.ai; also in ⌘K). Workbench-wide keys are bound in
// workbench-shell.tsx (⌘K, ⌘⇧O, ⌘/), the sidebar (⌘B) and the assistant (⌘J); the composer owns its own keys.
import { useI18n } from "@/components/i18n-provider"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"

export const isMacPlatform = () =>
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {keys.map((k) => (
        <kbd
          key={k}
          className="inline-flex h-6 min-w-6 items-center justify-center rounded-md bg-surface-raised px-1.5 font-sans text-[11px] font-medium text-muted-foreground"
        >
          {k}
        </kbd>
      ))}
    </span>
  )
}

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useI18n()
  const mod = isMacPlatform() ? "⌘" : "Ctrl"
  const shift = isMacPlatform() ? "⇧" : "Shift"
  const groups: { title: string; rows: [string, string[]][] }[] = [
    {
      title: t("shortcuts.general"),
      rows: [
        [t("shortcuts.search"), [mod, "K"]],
        [t("shortcuts.newConversation"), [mod, shift, "O"]],
        [t("shortcuts.toggleSidebar"), [mod, "B"]],
        [t("shortcuts.assistant"), [mod, "J"]],
        [t("shortcuts.help"), [mod, "/"]],
      ],
    },
    {
      title: t("shortcuts.composer"),
      rows: [
        [t("shortcuts.send"), ["Enter"]],
        [t("shortcuts.newline"), [shift, "Enter"]],
        [t("shortcuts.queue"), ["Enter"]],
        [t("shortcuts.steer"), [mod, "Enter"]],
        [t("shortcuts.stop"), ["Esc"]],
        [t("shortcuts.commands"), ["/"]],
        [t("shortcuts.attach"), [mod, "V"]],
      ],
    },
  ]
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("shortcuts.title")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-5">
          {groups.map((g) => (
            <section key={g.title} className="space-y-1">
              <h3 className="text-xs font-medium text-muted-foreground">{g.title}</h3>
              <ul>
                {g.rows.map(([label, keys]) => (
                  <li key={label} className="flex items-center justify-between gap-4 py-1.5 text-sm text-foreground">
                    <span className="min-w-0">{label}</span>
                    <Keys keys={keys} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
