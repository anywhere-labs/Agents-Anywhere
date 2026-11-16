// The pairing link as a QR code in a terminal. Encoding is `qrcode-generator` (MIT, no dependencies); this only
// draws its modules, two rows per text line with half blocks.
import qrcode from 'qrcode-generator'

/** Quiet zone around the code, in modules (scanners read 2 reliably on a screen; the standard asks for 4). */
const QUIET = 2

/**
 * `text` as lines of half-block characters. With `color`, every line sets black on white explicitly so the code
 * scans on dark and light terminal themes alike; without it (output piped to a file), dark modules are blocks.
 */
export function terminalQr(text: string, options: { readonly color: boolean }): string[] {
  const code = qrcode(0, 'L')
  code.addData(text, 'Byte')
  code.make()
  const size = code.getModuleCount()
  const dark = (row: number, col: number): boolean => row >= 0 && col >= 0 && row < size && col < size && code.isDark(row, col)
  const lines: string[] = []
  for (let row = -QUIET; row < size + QUIET; row += 2) {
    let line = ''
    for (let col = -QUIET; col < size + QUIET; col++) {
      const top = dark(row, col)
      const bottom = dark(row + 1, col)
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' '
    }
    lines.push(options.color ? `\u001b[30;47m${line}\u001b[0m` : line)
  }
  return lines
}
