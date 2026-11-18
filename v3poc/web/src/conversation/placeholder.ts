// A stand-in for an attachment's bytes where there is no host to load them (the web demo, the renderer in a plain
// browser): a soft gradient with the file name, as an SVG data URL. Deterministic per name.
export function placeholderImage(name: string): string {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) % 360
  const a = `hsl(${h} 70% 72%)`
  const b = `hsl(${(h + 60) % 360} 70% 58%)`
  const label = name.replace(/[<&>"]/g, '')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320" viewBox="0 0 320 320"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="320" height="320" fill="url(#g)"/><rect x="32" y="48" width="256" height="40" rx="10" fill="#fff" fill-opacity=".55"/><rect x="32" y="108" width="190" height="18" rx="6" fill="#fff" fill-opacity=".4"/><rect x="32" y="138" width="230" height="18" rx="6" fill="#fff" fill-opacity=".4"/><circle cx="264" cy="68" r="8" fill="#e11d48"/><text x="32" y="284" font-family="-apple-system,system-ui,sans-serif" font-size="20" fill="#fff" fill-opacity=".9">${label}</text></svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}
