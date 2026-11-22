/**
 * DSH 0.2.3 offers action cards (for example, enabling an official plugin) through a fenced block whose language is
 * `action-card`, written at the end of an answer. DSH's chat hides the block and shows the card below the answer.
 * AA has no card surface, so synced answers drop these blocks instead of showing their JSON.
 *
 * The scan mirrors `actionCardFences` of `@deepseek-ai/dsh-action-cards` (0.2.3-alpha.2), with which the DSH Host
 * reads cards, so exactly the blocks DSH treats as cards disappear. It is copied rather than imported: older DSH
 * runtimes neither ship that export nor write these blocks.
 */

/** Language of a block that offers a card, matched after lowercasing as DSH does. */
const ACTION_CARD_FENCE = 'action-card'

/** Up to three spaces, optionally the marker of the list item the fence starts, then the fence and its info string. */
const OPENING = /^( {0,3})((?:[-+*]|\d{1,9}[.)]) {1,4})?(`{3,}|~{3,})(.*)$/u

interface OpenFence {
  readonly closing: RegExp
  /** Whether the block offers a card; other fences are tracked so their content is never read as one. */
  readonly card: boolean
}

/** Lowercased leading letters, digits, `_` and `-` of an info string's first word. */
function languageOf(info: string): string {
  return info.trim().replace(/[^\w-][\s\S]*$/u, '').toLowerCase()
}

/** The fence a line opens, or undefined when the line opens none. */
function opened(line: string): OpenFence | undefined {
  const opening = OPENING.exec(line)
  if (opening === null) return undefined
  const indent = String(opening[1])
  const item: string | undefined = opening[2]
  const marker = String(opening[3])
  const info = String(opening[4])
  if (marker.startsWith('`') && info.includes('`')) return undefined
  // In a list item the closing line is indented from the item's content column.
  const closingIndent = (item === undefined ? 0 : indent.length + item.length) + 3
  return {
    closing: new RegExp(`^ {0,${String(closingIndent)}}${marker.charAt(0)}{${String(marker.length)},}[ \\t]*$`, 'u'),
    card: languageOf(info) === ACTION_CARD_FENCE,
  }
}

/**
 * Answer text without its `action-card` blocks, opening and closing lines included. A fence opens with at least
 * three backticks or tildes after at most three spaces, optionally after the marker of the list item it starts, and
 * closes at a line of the same character at least as long. An unclosed card block runs to the end of the text, so a
 * streaming answer never shows the card JSON. Blocks in block quotes, indented four or more spaces, or inside
 * another fence are kept, as DSH does not read them.
 * @param text - one text block of an assistant message.
 * @returns the text itself when it has no card block; otherwise the remaining lines, trailing whitespace removed.
 */
export function withoutActionCards(text: string): string {
  if (!/action-card/iu.test(text)) return text
  const kept: string[] = []
  let fence: OpenFence | undefined
  let removed = false
  // Each part keeps its own line ending, so kept lines are returned unchanged.
  for (const part of text.split(/(?<=\n)/u)) {
    const line = part.replace(/\r?\n$/u, '')
    if (fence === undefined) {
      fence = opened(line)
      if (fence?.card) removed = true
      else kept.push(part)
    } else {
      if (!fence.card) kept.push(part)
      if (fence.closing.test(line)) fence = undefined
    }
  }
  return removed ? kept.join('').trimEnd() : text
}
