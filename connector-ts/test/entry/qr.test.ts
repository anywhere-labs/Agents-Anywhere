import qrcode from 'qrcode-generator'
import { describe, expect, it } from 'vitest'

import { terminalQr } from '../../src/entry/qr.js'

describe('pairing QR code in the terminal', () => {
  it('draws every module of the code, two rows per line, inside a quiet zone', () => {
    const uri = `aa-pair://v1?d=dev_home&s=${encodeURIComponent('https://aa.example.com')}&k=${'A'.repeat(43)}`
    const code = qrcode(0, 'L')
    code.addData(uri, 'Byte')
    code.make()
    const size = code.getModuleCount()
    const lines = terminalQr(uri, { color: false })
    // Back from half blocks to modules.
    const grid: boolean[][] = lines.flatMap(line => {
      const chars = [...line]
      return [chars.map(c => c === '█' || c === '▀'), chars.map(c => c === '█' || c === '▄')]
    })
    expect(grid[0]).toHaveLength(size + 4)
    for (let row = 0; row < size + 4; row++) {
      for (let col = 0; col < size + 4; col++) {
        const inside = row >= 2 && col >= 2 && row < size + 2 && col < size + 2
        expect(grid[row]![col]).toBe(inside && code.isDark(row - 2, col - 2))
      }
    }
  })

  it('sets black on white explicitly when colouring, so light themes scan too', () => {
    const lines = terminalQr('aa-pair://x', { color: true })
    expect(lines.every(line => line.startsWith('\u001b[30;47m') && line.endsWith('\u001b[0m'))).toBe(true)
  })
})
