import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

interface PackageManifest {
  version: string
  exports: Record<string, unknown>
  dsh: {
    bundle: { patch: string }
    client: { platform: string; inject: string[] }
  }
  peerDependencies: Record<string, string>
  devDependencies: Record<string, string>
}

describe('DSH rc.7 plugin manifest', () => {
  it('declares one ordinary Host and Web Client bundle with rc.7 peers', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as PackageManifest

    expect(manifest.version).toBe('0.1.0')
    expect(manifest.exports).toHaveProperty('.')
    expect(manifest.exports).toHaveProperty('./client')
    expect(manifest.exports).toHaveProperty('./cordis.patch.yml')
    expect(manifest.dsh).toEqual({
      bundle: { patch: './cordis.patch.yml' },
      client: {
        platform: 'web',
        inject: [
          '@deepseek-ai/dsh-client-locale',
          '@deepseek-ai/dsh-client-runtime',
          '@deepseek-ai/dsh-client-ui-layout',
          '@deepseek-ai/dsh-client-ui-settings',
        ],
      },
    })

    for (const [name, range] of Object.entries(manifest.peerDependencies)) {
      if (name.startsWith('@deepseek-ai/dsh-')) expect(range).toBe('>=0.1.0-rc.7 <0.1.0-rc.8')
    }
    for (const [name, version] of Object.entries(manifest.devDependencies)) {
      if (name.startsWith('@deepseek-ai/dsh-')) expect(version).toBe('0.1.0-rc.7')
    }
  })

  it('does not declare or call Desktop-private profile and package-manager services', async () => {
    const packageText = await readFile(new URL('../package.json', import.meta.url), 'utf8')
    const hostText = await readFile(new URL('../src/bridge-service.ts', import.meta.url), 'utf8')
    const clientText = await readFile(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
    const combined = `${packageText}\n${hostText}\n${clientText}`

    expect(combined).not.toContain('desktopProfiles')
    expect(combined).not.toContain('desktopPnpm')
    expect(combined).not.toContain('@deepseek-ai/dsh-desktop')
    expect(hostText).not.toContain("profile: 'web'")
  })
})
