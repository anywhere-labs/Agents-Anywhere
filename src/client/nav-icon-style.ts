/**
 * One-shot DOM patcher that finds the settings-shell nav row whose label text
 * matches our plugin and replaces its default icon with the Agents Anywhere
 * logo. Implemented with a MutationObserver because the DSH settings shell
 * renders nav rows lazily and exposes no stable data attribute we can target
 * from CSS alone.
 *
 * Themes: we swap two pre-baked SVG data URLs based on the theme attribute
 * the DSH theme plugin applies (`body[data-ds-dark-theme]`).
 */

const SVG_LETTERS_PATH_1 = "M101.141 53H136.632C151.023 53 162.689 64.6662 162.689 79.0573V112.904H148.112V79.0573C148.112 78.7105 148.098 78.3662 148.072 78.0251L112.581 112.898C112.701 112.902 112.821 112.904 112.941 112.904H148.112V126.672H112.941C98.5504 126.672 86.5638 114.891 86.5638 100.5V66.7434H101.141V100.5C101.141 101.15 101.191 101.792 101.289 102.422L137.56 66.7816C137.255 66.7563 136.945 66.7434 136.632 66.7434H101.141V53Z"
const SVG_LETTERS_PATH_2 = "M65.2926 124.136L14 66.7372H34.6355L64.7495 100.436V66.7372H80.1365V118.47C80.1365 126.278 70.4953 129.958 65.2926 124.136Z"

function buildLogoSvg(bg: string, fg: string): string {
  return `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 180 180'><rect width='180' height='180' rx='37' fill='${bg}'/><path fill='${fg}' d='${SVG_LETTERS_PATH_1}'/><path fill='${fg}' d='${SVG_LETTERS_PATH_2}'/></svg>`
}

const LIGHT_ICON_URL = "url(\"data:image/svg+xml;utf8," + buildLogoSvg("%231f1f1f", "%23ffffff") + "\")"
const DARK_ICON_URL = "url(\"data:image/svg+xml;utf8," + buildLogoSvg("%23f5f5f5", "%231f1f1f") + "\")"

/** Locale strings that identify our nav row across languages. */
const NAV_LABEL_MARKERS = ['Agent远程', 'Agent Remote']

/** Container element roles that the settings shell uses for nav rows. */
const ROW_SELECTOR = 'button, a, [role="tab"], [role="button"], [role="menuitem"], li'

/** Marker class we attach once the row has been patched. */
const PATCHED_CLASS = 'dsh-aa-connector-nav-patched'

/** Selector for the default icon element(s) we want to hide inside the row. */
const ICON_SELECTOR =
  'svg, i[class*="icon"], .icon, [class*="Icon"], img, [aria-hidden="true"]'

/** Selector we use to locate the icon's *position* — keep the first one. */
const FIRST_ICON_SELECTOR = 'svg, i, .icon, [class*="icon"], img, [aria-hidden="true"]'

interface PatcherState {
  observer: MutationObserver | null
  matchedRows: WeakSet<Element>
}

const STATE: PatcherState = {
  observer: null,
  matchedRows: new WeakSet(),
}

export function startNavIconPatcher(): void {
  if (typeof document === 'undefined') return
  if (STATE.observer !== null) return
  applyThemeStyle()

  const scan = (): void => {
    const rows = document.querySelectorAll<HTMLElement>(ROW_SELECTOR)
    rows.forEach(patchRow)
  }

  // First pass — many shells render synchronously, so the row is already in
  // the DOM when this effect runs.
  scan()

  // Subsequent passes — catch the nav row when the user opens the settings panel.
  const observer = new MutationObserver(() => scan())
  observer.observe(document.body, { childList: true, subtree: true })
  STATE.observer = observer
}

function patchRow(row: HTMLElement): void {
  if (STATE.matchedRows.has(row)) return
  const text = row.textContent ?? ''
  const isOurs = NAV_LABEL_MARKERS.some((marker) => text.includes(marker))
  if (!isOurs) return

  STATE.matchedRows.add(row)
  row.classList.add(PATCHED_CLASS)

  // Hide any default icon inside the row. We keep the label intact.
  const candidates = row.querySelectorAll<HTMLElement>(ICON_SELECTOR)
  candidates.forEach((el) => {
    // Skip our own marker span (if we run twice somehow).
    if (el.dataset.aaConnectorNavIcon === 'true') return
    el.style.setProperty('display', 'none', 'important')
  })

  // Inject the Agents Anywhere logo as a leading marker span.
  if (row.querySelector('[data-aa-connector-nav-icon="true"]') !== null) return
  const icon = document.createElement('span')
  icon.dataset.aaConnectorNavIcon = 'true'
  icon.setAttribute('aria-hidden', 'true')
  icon.style.cssText = [
    'display: inline-block',
    'flex-shrink: 0',
    'width: 18px',
    'height: 18px',
    'margin-right: 8px',
    'background-image: ' + LIGHT_ICON_URL,
    'background-size: contain',
    'background-repeat: no-repeat',
    'background-position: center',
    'vertical-align: middle',
  ].join(';')
  // Insert before the first child so the icon leads the label.
  row.insertBefore(icon, row.firstChild)
}

function applyThemeStyle(): void {
  if (document.getElementById('dsh-aa-connector-nav-theme-style') !== null) return
  const style = document.createElement('style')
  style.id = 'dsh-aa-connector-nav-theme-style'
  style.dataset.plugin = '@agents-anywhere/dsh-aa-connector'
  style.textContent = `
body[data-ds-dark-theme] .${PATCHED_CLASS} [data-aa-connector-nav-icon="true"] {
  background-image: ${DARK_ICON_URL} !important;
}
`
  document.head.appendChild(style)
}