import { apiClient } from "@/lib/api"
import type { AnnouncementSettings, PublicAnnouncement } from "./types"

export const announcementsApi = {
  current(signal?: AbortSignal) {
    return apiClient.get<{ announcement: PublicAnnouncement | null }>("/announcement", {
      auth: false, cache: "no-store", signal,
    })
  },
  settings(token: string) {
    return apiClient.get<AnnouncementSettings>("/admin/announcement", { token, cache: "no-store" })
  },
  save(token: string, body: Pick<AnnouncementSettings, "enabled" | "markdown">) {
    return apiClient.put<AnnouncementSettings>("/admin/announcement", body, { token })
  },
}
