"use client"

import { File, FileCode, FileImage, FileArchive, FileText, FileAudio, FileVideo, FileSpreadsheet } from "lucide-react"
import { cn } from "@/lib/utils"

export function FileTypeIcon({ name, className }: { name: string; className?: string }) {
  const extension = name.toLowerCase().split(".").at(-1) ?? ""
  const Icon = /^(png|jpe?g|gif|webp|svg|bmp|ico)$/.test(extension) ? FileImage
    : /^(zip|tar|gz|7z|rar)$/.test(extension) ? FileArchive
    : /^(mp3|wav|ogg|aac|m4a)$/.test(extension) ? FileAudio
    : /^(mp4|mov|webm|avi)$/.test(extension) ? FileVideo
    : /^(csv|xlsx?)$/.test(extension) ? FileSpreadsheet
    : /^(ts|tsx|js|jsx|json|py|rs|go|java|c|cpp|h|css|html|vue|sh|yaml|yml|toml|swift)$/.test(extension) ? FileCode
    : /^(md|mdx|txt|log|pdf)$/.test(extension) ? FileText : File
  return <Icon aria-hidden="true" className={cn("shrink-0 text-muted-foreground", className)} />
}
