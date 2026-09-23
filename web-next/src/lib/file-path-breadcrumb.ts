export function filePathBreadcrumbSegments(path: string) {
  const normalized = path.trim().replaceAll("\\", "/") || "."
  const parts = normalized.split("/").filter(Boolean)
  if (parts.length === 0) return [{ label: "/", path: "/" }]

  const prefix = normalized.startsWith("//") ? "//" : normalized.startsWith("/") ? "/" : ""
  // A UNC share is a single root: the server alone is not a directory.
  if (prefix === "//" && parts.length >= 2) parts.splice(0, 2, `${parts[0]}/${parts[1]}`)

  return parts.map((label, index) => {
    const target = prefix + parts.slice(0, index + 1).join("/")
    return { label, path: /^[A-Za-z]:$/.test(target) ? `${target}/` : target }
  })
}

export function filePathBreadcrumbParent(path: string) {
  const segments = filePathBreadcrumbSegments(path)
  const parent = segments.at(-2)
  if (parent) return parent.path
  const root = segments[0]?.path ?? "."
  if (root.startsWith("//") || /^[A-Za-z]:\/$/.test(root) || root === "~") return root
  return root.startsWith("/") ? "/" : "."
}
