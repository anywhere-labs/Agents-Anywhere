export function shouldAuthorizeDownloadUrl(
  rawUrl: string,
  browserOrigin = typeof window === "undefined" ? "" : window.location.origin,
  apiBase = process.env.NEXT_PUBLIC_AGENTS_ANYWHERE_API ?? "",
) {
  const url = rawUrl.trim()
  if (!url) return false

  const fallbackOrigin = browserOrigin || "http://localhost"
  let target: URL
  try {
    target = new URL(url, fallbackOrigin)
  } catch {
    return false
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return false

  const trustedOrigins = new Set<string>()
  if (browserOrigin) {
    try {
      trustedOrigins.add(new URL(browserOrigin).origin)
    } catch {
      // An invalid browser origin cannot establish a trusted absolute URL.
    }
  }
  if (apiBase) {
    try {
      trustedOrigins.add(new URL(apiBase, fallbackOrigin).origin)
    } catch {
      // An invalid API base cannot establish a trusted absolute URL.
    }
  }
  return trustedOrigins.has(target.origin)
}
