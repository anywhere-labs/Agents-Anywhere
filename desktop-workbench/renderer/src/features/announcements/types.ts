export type PublicAnnouncement = {
  markdown: string
  publishedAt: string
}

export type AnnouncementSettings = {
  enabled: boolean
  markdown: string
  publishedAt: string | null
}
