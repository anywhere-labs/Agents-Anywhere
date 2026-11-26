// Display name a normal device shows for this client while it controls a terminal ("Chrome · macOS").
// Encrypted devices ignore it and use the paired-client label.

export function clientLabel(userAgent: string, platformHint?: string): string {
  const ua = userAgent
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Browser"
  const os = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Mac OS X|Macintosh/.test(ua)
          ? "macOS"
          : /Windows/.test(ua)
            ? "Windows"
            : /Linux/.test(ua)
              ? "Linux"
              : platformHint || ""
  return (os ? `${browser} · ${os}` : browser).slice(0, 80)
}
