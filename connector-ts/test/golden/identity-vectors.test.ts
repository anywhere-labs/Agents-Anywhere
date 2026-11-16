import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as id from '../../src/domain/identity/index.js'
import type { JsonValue } from '../../src/domain/identity/index.js'

type JsonObject = { [key: string]: JsonValue }

interface Vector {
  readonly name?: string
  readonly input: JsonObject
  readonly output?: JsonValue
  readonly error?: string
}

interface Category {
  readonly source: string
  readonly description: string
  readonly vectors: readonly Vector[]
}

const VECTORS_URL = new URL('../../../contracts/identity-vectors/1.0/vectors.json', import.meta.url)
const document = JSON.parse(readFileSync(VECTORS_URL, 'utf8')) as {
  version: string
  categories: Record<string, Category>
}

const str = (value: JsonValue | undefined): string => {
  if (typeof value !== 'string') throw new TypeError(`expected string, got ${JSON.stringify(value)}`)
  return value
}
const strOrNull = (value: JsonValue | undefined): string | null => (value === null || value === undefined ? null : str(value))
const num = (value: JsonValue | undefined): number => {
  if (typeof value !== 'number') throw new TypeError(`expected number, got ${JSON.stringify(value)}`)
  return value
}
const obj = (value: JsonValue | undefined): JsonObject => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('expected object')
  return value
}
const arr = (value: JsonValue | undefined): JsonValue[] => {
  if (!Array.isArray(value)) throw new TypeError('expected array')
  return value
}
const platform = (value: JsonValue | undefined): id.HostPlatform => str(value) as id.HostPlatform

const handlers: Record<string, (input: JsonObject) => JsonValue> = {
  'session.stableRuntimeSessionId': i => id.stableRuntimeSessionId(str(i.connectorId), str(i.runtime), str(i.externalSessionId)),
  'session.codexStableSessionId': i => id.codexStableSessionId(str(i.namespace), str(i.externalSessionId)),
  'session.claudeStableSessionId': i => id.claudeStableSessionId(str(i.namespace), str(i.externalSessionId)),
  'session.sourceKeyDigest': i => id.sourceKeyDigest({ kind: str(i.kind), key: str(i.key) }),
  'session.namespace': i => id.sessionNamespace({
    connectorId: str(i.connectorId),
    runtimeType: str(i.runtimeType),
    runtimeId: str(i.runtimeId),
    sourceKey: i.sourceKey === null ? null : { kind: str(obj(i.sourceKey).kind), key: str(obj(i.sourceKey).key) },
  }),
  'session.filesystemResourceKey': i => id.filesystemResourceKey(str(i.canonicalPath), platform(i.platform)),
  'session.sourceKey': i => {
    const key = str(i.runtime) === 'dsh'
      ? id.dshSessionSourceKey(str(i.home), platform(i.platform))
      : id.codexSessionSourceKey(str(i.home), platform(i.platform))
    return { kind: key.kind, key: key.key }
  },
  'session.dshEndToEnd': i => {
    const sourceKey = id.dshSessionSourceKey(str(i.dshHome), platform(i.platform))
    const namespace = id.sessionNamespace({ connectorId: str(i.connectorId), runtimeType: 'dsh', runtimeId: str(i.runtimeId), sourceKey })
    return { namespace, sessionId: id.dshPluginSessionId(namespace, str(i.externalSessionId)) }
  },
  'session.acpNativeInventoryId': i => id.acpNativeInventorySessionId(str(i.runtimeId), str(i.nativeSessionId)),
  'session.piNativeSessionId': i => id.piNativeSessionId(str(i.runtimeId), str(i.path), str(i.nativeSessionId)),
  'storage.acpRuntimeRoot': i => id.acpRuntimeRootName(str(i.sessionNamespace), str(i.runtimeId)),

  'selection.protocolSelectionId': i => id.protocolSelectionId(str(i.runtime), str(i.catalogType), i.identity ?? null),
  'selection.customModelSelectionId': i => id.customModelSelectionId(str(i.runtime), str(i.modelId), strOrNull(i.effortId)),
  'selection.claudePermissionSelectionId': i => id.claudePermissionSelectionId(str(i.permissionId)),
  'selection.dshModelSelectionId': i => id.dshModelSelectionId(str(i.provider), str(i.model), strOrNull(i.effort)),
  'selection.dshPermissionSelectionId': i => id.dshPermissionSelectionId(str(i.preset)),
  'selection.catalogs': i => {
    switch (str(i.kind)) {
      case 'codexPermission':
        return i.identity === null ? id.codexPermissionSelectionId(str(i.id)) : id.codexPermissionSelectionId(str(i.id), obj(i.identity))
      case 'codexModel': {
        const reasoning = arr(i.reasoningIds).map(str)
        return {
          selectionId: reasoning.length ? null : id.codexModelSelectionId(str(i.modelId), null),
          reasoning: reasoning.map(effort => id.codexModelSelectionId(str(i.modelId), effort)),
        }
      }
      case 'claudePermission':
        return id.claudePermissionSelectionId(str(i.id))
      case 'claudeModel':
        return id.claudeModelSelectionId(str(i.modelId))
      case 'claudeEffort':
        return id.claudeModelSelectionId(str(i.modelId), str(i.effortId))
      default:
        throw new Error(`unknown catalog kind ${String(i.kind)}`)
    }
  },
  'selection.acpSelectionId': i => id.acpSelectionId(strOrNull(i.model), strOrNull(i.effort)),

  'timeline.codexClientMessageItemId': i => id.codexClientMessageItemId(str(i.externalSessionId), str(i.clientMessageId)),
  'timeline.codexTurnPositionItemId': i => i.lane === null
    ? id.codexTurnPositionItemId(str(i.externalSessionId), str(i.turnId), num(i.position))
    : id.codexTurnPositionItemId(str(i.externalSessionId), str(i.turnId), num(i.position), str(i.lane)),
  'timeline.codexTurnItemLane': i => ({
    lane: id.codexTurnItemLane(str(i.rawType), strOrNull(i.role)),
    usesTurnPositionIdentity: id.codexUsesTurnPositionIdentity(str(i.rawType), strOrNull(i.role)),
    isUserMessage: id.codexIsUserMessage(str(i.rawType), strOrNull(i.role)),
  }),
  'timeline.codexNextTurnLanePosition': i => {
    const state = new Map<string, number>()
    return arr(i.lanes).map(lane => id.codexNextTurnLanePosition(state, str(lane)))
  },
  'timeline.codexDerivedKeyFromValues': i => id.codexDerivedKeyFromValues(str(i.rawType), strOrNull(i.role), strOrNull(i.turnId), num(i.index)),
  'timeline.codexTimelineItemIdFromValues': i => id.codexTimelineItemIdFromValues(
    strOrNull(i.nativeId), strOrNull(i.clientMessageId), str(i.rawType), strOrNull(i.role), strOrNull(i.turnId),
    str(i.externalSessionId), num(i.index),
  ),
  'timeline.codexTimelineItemId': i => id.codexTimelineItemId(obj(i.raw), str(i.externalSessionId), num(i.index)),
  'timeline.codexAsyncInputIds': i => ({ ...id.codexAsyncInputIds(str(i.callId)) }),

  'timeline.claudeMessageAndToolItemId': i => {
    const session = { sessionId: str(i.sessionId), externalSessionId: strOrNull(i.externalSessionId) }
    return {
      message: id.claudeMessageItemId(session, str(i.nativeMessageId)),
      tool: id.claudeToolItemId(session, str(i.nativeMessageId)),
    }
  },
  'timeline.claudeSystemItemId': i => id.claudeSystemItemId(
    { sessionId: str(i.sessionId), externalSessionId: strOrNull(i.externalSessionId) },
    str(i.turnId), strOrNull(i.nativeMessageId), num(i.blockIndex), str(i.blockType),
  ),
  'timeline.claudeStableId': i => id.claudeStableId(...arr(i.parts)),
  'timeline.claudeHistoryTurnId': i => id.claudeHistoryTurnId(strOrNull(i.externalSessionId), str(i.turnSeed)),

  'timeline.acpProjectionItemId': i => {
    const projection = new id.AcpProjectionIdentity(str(i.sessionId), str(i.epoch))
    const ids: JsonValue[] = []
    for (const update of arr(i.updates)) {
      try {
        ids.push(projection.apply(obj(update)))
      } catch (error) {
        if (!(error instanceof id.IdentityInputError)) throw error
        ids.push({ error: 'ValueError' })
        break
      }
    }
    return ids
  },
  'timeline.piHistoryItemId': i => {
    const suffix = i.suffix
    if (typeof suffix !== 'string' && typeof suffix !== 'number') throw new TypeError('suffix')
    return id.piHistoryItemId(str(i.sessionId), obj(i.entry), num(i.entryIndex), suffix)
  },
  'timeline.dshTimelineItemId': i => id.dshTimelineItemId(str(i.externalSessionId), str(i.kind), str(i.businessId)),

  'dshPlugin.sessionId': i => id.dshPluginSessionId(str(i.namespace), str(i.externalSessionId)),
  'dshPlugin.nativeSessionId': i => id.dshPluginNativeSessionId(str(i.namespace), str(i.platformSessionId)),
  'dshPlugin.userMessageId': i => id.dshPluginUserMessageId(str(i.externalSessionId), str(i.clientMessageId)),
  'dshPlugin.clientMessageId': i => id.dshPluginClientMessageId(str(i.externalSessionId), str(i.nativeMessageId)),
  'dshPlugin.itemId': i => id.dshPluginItemId(str(i.externalSessionId), str(i.kind), str(i.businessId)),

  'planning.stableId': i => id.planningStableId(str(i.prefix), ...arr(i.parts).map(str)),

  'unicode.casefold': i => id.pythonCasefold(str(i.text)),
  'unicode.isalnum': i => id.pythonIsAlnum(String.fromCodePoint(num(i.codePoint))),
  'unicode.nfc': i => id.nfc(str(i.text)),
}

function describeInput(input: JsonObject): string {
  const text = JSON.stringify(input)
  return text.length > 300 ? `${text.slice(0, 300)}…` : text
}

describe(`identity vectors ${document.version}`, () => {
  it('has a TypeScript implementation for every category', () => {
    expect(Object.keys(document.categories).filter(name => !(name in handlers))).toEqual([])
    expect(Object.keys(handlers).filter(name => !(name in document.categories))).toEqual([])
  })

  for (const [name, category] of Object.entries(document.categories)) {
    it(`${name} (${category.vectors.length} vectors)`, () => {
      const handler = handlers[name]
      if (!handler) throw new Error(`no handler for ${name}`)
      expect(category.vectors.length).toBeGreaterThanOrEqual(20)
      const failures: string[] = []
      category.vectors.forEach((vector, index) => {
        const label = `#${index}${vector.name ? ` ${vector.name}` : ''} ${describeInput(vector.input)}`
        let actual: JsonValue
        try {
          actual = handler(vector.input)
        } catch (error) {
          if (vector.error === undefined) failures.push(`${label}: threw ${String(error)}`)
          return
        }
        if (vector.error !== undefined) {
          failures.push(`${label}: expected ${vector.error}, got ${JSON.stringify(actual)}`)
          return
        }
        try {
          expect(actual).toEqual(vector.output)
        } catch {
          failures.push(`${label}: expected ${JSON.stringify(vector.output)}, got ${JSON.stringify(actual)}`)
        }
      })
      expect(failures.slice(0, 20)).toEqual([])
    })
  }
})

/**
 * Case pairs that Node's ICU (Unicode 17) knows but the generator's Python (Unicode 16) treats as
 * unassigned, so v2 leaves them unfolded: Latin Extended-D additions and Beria Erfe.
 */
const NEWER_UNICODE_CASE_PAIRS: ReadonlyArray<readonly [number, number]> = [
  [0xa7ce, 0xa7d4],
  [0x16ea0, 0x16eb8],
]

describe('casefold covers every code point', () => {
  it('folds exactly the code points the vectors list', () => {
    const expected = new Map<string, string>()
    for (const vector of document.categories['unicode.casefold']?.vectors ?? []) {
      const text = str(vector.input.text)
      if (Array.from(text).length === 1) expected.set(text, str(vector.output))
    }
    const mismatches: string[] = []
    for (let code = 0; code <= 0x10ffff; code++) {
      if (code >= 0xd800 && code <= 0xdfff) continue
      if (NEWER_UNICODE_CASE_PAIRS.some(([start, end]) => code >= start && code <= end)) continue
      const char = String.fromCodePoint(code)
      const want = expected.get(char) ?? char
      const got = id.pythonCasefold(char)
      if (got !== want) mismatches.push(`U+${code.toString(16).toUpperCase().padStart(4, '0')}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`)
    }
    expect(mismatches).toEqual([])
  })
})
