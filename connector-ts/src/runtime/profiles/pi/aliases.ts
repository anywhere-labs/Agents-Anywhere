// Pi 原生会话 ID 的别名表：对外的 ID 一经报告就不再变。
//
// 为什么需要：新会话在 Pi 还没写原生文件之前就被空闲回收时，醒来只能开一个新的原生会话接上（session.ts
// `restartEmpty`），Pi 给的会话 ID 随之变了。A 把 `RuntimeSession.nativeSessionId` 记作会话的 externalSessionId，
// 它也是 Timeline 条目 source.sessionId、原生会话目录去重和只读历史条目 ID（`pi_native_…`）的输入，所以对外
// 必须一直是最初那个 ID。
//
// 做法：记下「真实 ID → 最初 ID」，持久化在实例数据目录（`<实例目录>/pi-session-aliases.json`）。所有对外的地方
// （RuntimeSession.nativeSessionId、listNativeSessions、readNativeHistory 的输入与条目 ID、open(existing)）用最初
// 的 ID；进程、文件锁、权限与计划标记、写入校验按真实 ID。没有别名的会话两者相同，文件不存在时表为空。

import { readFileSync } from 'node:fs'

import type { PiAliasLookup } from '../../companions/native-history/index.js'
import { privateJson } from './settings.js'

interface AliasFile {
  readonly version: 1
  /** 真实原生 ID → 最初对外报告的 ID。 */
  readonly aliases: Readonly<Record<string, string>>
}

export class PiSessionAliases implements PiAliasLookup {
  private readonly toOriginal = new Map<string, string>()
  private chain: Promise<unknown> = Promise.resolve()

  constructor(readonly file: string) {
    let parsed: Partial<AliasFile> = {}
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<AliasFile>
    } catch {
      // 没有或读不了：当作空表（只影响休眠前从未写过原生文件的新会话）
    }
    const aliases = parsed.version === 1 && parsed.aliases !== null && typeof parsed.aliases === 'object' ? parsed.aliases : {}
    for (const [actual, original] of Object.entries(aliases)) {
      if (typeof original === 'string' && original !== '' && original !== actual) this.toOriginal.set(actual, original)
    }
  }

  /** 对外的 ID：真实 ID 有别名时给最初的那个，否则原样。 */
  original(actual: string): string {
    return this.toOriginal.get(actual) ?? actual
  }

  /** 对外 ID 现在对应的真实 ID（最近一次记下的）；没有别名时原样。 */
  actual(original: string): string {
    let found = original
    for (const [actual, first] of this.toOriginal) if (first === original) found = actual
    return found
  }

  /**
   * 会话换了原生 ID：`previous` 是换之前的真实 ID（本身可能已有别名），`next` 是新的。
   * 写盘完成后才返回；同一实例内串行读改写。
   */
  record(previous: string, next: string): Promise<void> {
    if (previous === next) return Promise.resolve()
    const original = this.original(previous)
    this.toOriginal.delete(previous)
    if (original !== next) this.toOriginal.set(next, original)
    const write = this.chain.catch(() => undefined).then(() => privateJson(this.file, { version: 1, aliases: Object.fromEntries(this.toOriginal) } satisfies AliasFile))
    this.chain = write
    return write
  }
}
