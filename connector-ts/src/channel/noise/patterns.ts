// 握手模式（Noise 规范 §7）与协议名解析。AA 只用 XXpsk0（配对）与 KK（重连）；
// 其他基本模式只为跑官方测试向量，证明状态机按规范实现。

import { NoiseError } from './crypto.js'

export type Token = 'e' | 's' | 'ee' | 'es' | 'se' | 'ss' | 'psk'

export interface HandshakePattern {
  readonly name: string
  /** [发起方的预消息, 响应方的预消息] */
  readonly preMessages: readonly [readonly Token[], readonly Token[]]
  /** 依次为 发起方 → 响应方 → 发起方 … */
  readonly messages: readonly (readonly Token[])[]
  readonly oneWay: boolean
}

type Base = { pre: [Token[], Token[]]; messages: Token[][] }

const BASE: Readonly<Record<string, Base>> = {
  N: { pre: [[], ['s']], messages: [['e', 'es']] },
  K: { pre: [['s'], ['s']], messages: [['e', 'es', 'ss']] },
  X: { pre: [[], ['s']], messages: [['e', 'es', 's', 'ss']] },
  NN: { pre: [[], []], messages: [['e'], ['e', 'ee']] },
  NK: { pre: [[], ['s']], messages: [['e', 'es'], ['e', 'ee']] },
  NX: { pre: [[], []], messages: [['e'], ['e', 'ee', 's', 'es']] },
  XN: { pre: [[], []], messages: [['e'], ['e', 'ee'], ['s', 'se']] },
  XK: { pre: [[], ['s']], messages: [['e', 'es'], ['e', 'ee'], ['s', 'se']] },
  XX: { pre: [[], []], messages: [['e'], ['e', 'ee', 's', 'es'], ['s', 'se']] },
  KN: { pre: [['s'], []], messages: [['e'], ['e', 'ee', 'se']] },
  KK: { pre: [['s'], ['s']], messages: [['e', 'es', 'ss'], ['e', 'ee', 'se']] },
  KX: { pre: [['s'], []], messages: [['e'], ['e', 'ee', 'se', 's', 'es']] },
  IN: { pre: [[], []], messages: [['e', 's'], ['e', 'ee', 'se']] },
  IK: { pre: [[], ['s']], messages: [['e', 'es', 's', 'ss'], ['e', 'ee', 'se']] },
  IX: { pre: [[], []], messages: [['e', 's'], ['e', 'ee', 'se', 's', 'es']] },
}

/** 解析 `XXpsk0`、`KK`、`NNpsk0+psk2` 这样的模式名。 */
export function parsePattern(name: string): HandshakePattern {
  const match = /^([NKXI]{1,2})((?:psk\d)(?:\+psk\d)*)?$/.exec(name)
  const base = match ? BASE[match[1]!] : undefined
  if (!match || !base) throw new NoiseError(`noise: unsupported handshake pattern ${name}`)
  const messages = base.messages.map((tokens) => [...tokens])
  const modifiers = match[2] ? match[2].split('+') : []
  for (const modifier of modifiers) {
    const index = Number(modifier.slice(3))
    if (index === 0) messages[0]!.unshift('psk')
    else if (index <= messages.length) messages[index - 1]!.push('psk')
    else throw new NoiseError(`noise: ${modifier} is out of range for ${match[1]}`)
  }
  return {
    name,
    preMessages: [base.pre[0], base.pre[1]],
    messages,
    oneWay: match[1]!.length === 1,
  }
}

export interface ProtocolName {
  readonly full: string
  readonly pattern: HandshakePattern
}

export const SUITE = '25519_AESGCM_SHA256'

/** 只接受 `Noise_<pattern>_25519_AESGCM_SHA256`。 */
export function parseProtocolName(full: string): ProtocolName {
  const prefix = 'Noise_'
  const suffix = `_${SUITE}`
  if (!full.startsWith(prefix) || !full.endsWith(suffix)) {
    throw new NoiseError(`noise: unsupported protocol ${full}; only ${SUITE} is implemented`)
  }
  return { full, pattern: parsePattern(full.slice(prefix.length, full.length - suffix.length)) }
}
