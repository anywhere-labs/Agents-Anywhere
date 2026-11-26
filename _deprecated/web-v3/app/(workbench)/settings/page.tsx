// `/settings` (and old `/settings#vault`-style links): the home view; the workbench shell opens the settings dialog
// over it on this route and goes home when it closes. Settings are normally opened from the account menu or ⌘,.
import { HomeContent } from "@/components/workbench/home-content"

export default function SettingsPage() {
  return <HomeContent />
}
