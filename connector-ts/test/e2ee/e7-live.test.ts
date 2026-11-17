import { readFile, writeFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { fromB64url } from '../../src/channel/index.js'
import {
  encryptedPath,
  formatReport,
  loadIdentity,
  plainPath,
  runE7,
  tunnelChannels,
  type E7Config,
} from '../../scripts/e2ee-latency.js'

// E-7 对真实部署的测量。没有 AA_E7_CONFIG 时跳过（CI 不跑）：
//   AA_E7_CONFIG=/path/e7.json [AA_E7_REPORT=/path/report.json] corepack yarn vitest run test/e2ee/e7-live.test.ts
// 配置字段见 scripts/e2ee-latency.ts 的 E7Config。

const configPath = process.env['AA_E7_CONFIG']

describe.runIf(configPath)('E-7：真实部署上加密模式与普通模式的首屏、流式 P95', () => {
  it(
    'P95 增加不超过 20%',
    async () => {
      const config = JSON.parse(await readFile(configPath!, 'utf8')) as E7Config
      const identity = await loadIdentity(config.encrypted)
      const endpoint = { ...config.encrypted, deviceId: identity.deviceId, identity }
      const report = await runE7(config, {
        plain: async () => plainPath(config.plain),
        encrypted: encryptedPath(tunnelChannels(endpoint), {
          deviceId: identity.deviceId,
          directoryKey: fromB64url(identity.directoryKey),
          register: async (commandId, inputDigest) => {
            const response = await fetch(new URL('/api/v3/e2ee/commands', config.encrypted.serverUrl), {
              method: 'POST',
              headers: { authorization: `Bearer ${config.encrypted.accessToken}`, 'content-type': 'application/json' },
              body: JSON.stringify({ commandId, deviceId: identity.deviceId, inputDigest }),
            })
            if (!response.ok) throw new Error(`register command: HTTP ${response.status}`)
          },
        }),
      })
      console.info(formatReport(report))
      if (process.env['AA_E7_REPORT']) await writeFile(process.env['AA_E7_REPORT'], JSON.stringify(report, null, 2))
      expect(report.pass).toBe(true)
    },
    30 * 60 * 1000,
  )
})
