// Detecting an installed Codex App per platform, against a fake file system.
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { codexAppInstalled, type InstallProbe } from '../../src/runtime/companions/codex/index.js'

function probe(dirs: string[], listings: Record<string, string[]> = {}, files: Record<string, string> = {}): InstallProbe {
  return {
    isDirectory: path => dirs.includes(path),
    list: path => listings[path] ?? [],
    read: path => files[path],
  }
}

describe('Codex App installation', () => {
  it('finds ChatGPT.app or Codex.app in the system or the user Applications folder on macOS', () => {
    expect(codexAppInstalled('darwin', {}, '/Users/u', probe([join('/Applications', 'ChatGPT.app')]))).toBe(true)
    expect(codexAppInstalled('darwin', {}, '/Users/u', probe([join('/Users/u', 'Applications', 'Codex.app')]))).toBe(true)
    expect(codexAppInstalled('darwin', {}, '/Users/u', probe(['/Applications/Other.app']))).toBe(false)
  })

  it('finds the Codex package data folder on Windows', () => {
    const packages = join('C:\\Users\\u\\AppData\\Local', 'Packages')
    expect(codexAppInstalled('win32', { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'C:\\Users\\u', probe([], { [packages]: ['Microsoft.Foo_1', 'OpenAI.Codex_2p2nqsd0c76g0'] }))).toBe(true)
    expect(codexAppInstalled('win32', { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'C:\\Users\\u', probe([], { [packages]: ['Microsoft.Foo_1'] }))).toBe(false)
  })

  it('finds a desktop entry that handles codex:// on Linux', () => {
    const apps = join('/home/u', '.local', 'share', 'applications')
    const handler = probe([], { [apps]: ['codex.desktop', 'notes.txt'] }, { [join(apps, 'codex.desktop')]: '[Desktop Entry]\nMimeType=x-scheme-handler/codex;\n' })
    expect(codexAppInstalled('linux', {}, '/home/u', handler)).toBe(true)
    const other = probe([], { [join('/usr/share', 'applications')]: ['editor.desktop'] }, { [join('/usr/share', 'applications', 'editor.desktop')]: 'MimeType=text/plain;' })
    expect(codexAppInstalled('linux', {}, '/home/u', other)).toBe(false)
    expect(codexAppInstalled('freebsd', {}, '/home/u', handler)).toBe(false)
  })
})
