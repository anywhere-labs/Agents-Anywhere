import { AgentDevice } from '../../model/AgentSession';

/**
 * Device pairing flow.
 *
 * Port of `feature/devices/DevicePairingFlow.kt`.
 *
 * The wizard walks one linear path with two branches, and the shell commands it
 * shows are built here so the quoting rules are testable on their own:
 *
 * ```
 * ConnectionMethod ──> DesktopInstall ──> (done)
 *                  └─> CliConfirm ──> Name ──> CliMethod ──> Command   (token)
 *                                                      └──> PairCode  (code)
 * ```
 */

export enum DevicePairingStep {
  ConnectionMethod = 0,
  DesktopInstall = 1,
  CliConfirm = 2,
  Name = 3,
  CliMethod = 4,
  Command = 5,
  PairCode = 6,
}

/** Android's `DevicePairingStep.previous()`. */
export function previousPairingStep(step: DevicePairingStep): DevicePairingStep {
  if (step === DevicePairingStep.Command || step === DevicePairingStep.PairCode) {
    return DevicePairingStep.CliMethod;
  }
  if (step === DevicePairingStep.CliMethod) {
    return DevicePairingStep.Name;
  }
  return DevicePairingStep.ConnectionMethod;
}

/** A device plus the one-time credential used to start its connector. */
export interface DeviceSetupCredential {
  device: AgentDevice;
  serverUrl: string;
  connectorToken: string;
}

/**
 * The bare address a connector should talk to.
 *
 * Android keeps only `host[:port]` for an `https` URL and drops a default 443;
 * anything it cannot parse is passed through untouched, which matters for a
 * self-hosted address that is already just a host name.
 */
export function pairingServerAddress(serverUrl: string): string {
  const trimmed: string = serverUrl.trim();
  if (!trimmed.toLowerCase().startsWith('https://')) {
    return trimmed;
  }
  const rest: string = trimmed.substring('https://'.length);
  const slash: number = rest.indexOf('/');
  const authority: string = slash >= 0 ? rest.substring(0, slash) : rest;
  if (authority.length === 0) {
    return trimmed;
  }
  const colon: number = authority.lastIndexOf(':');
  if (colon > 0) {
    const host: string = authority.substring(0, colon);
    const port: string = authority.substring(colon + 1);
    if (port === '443') {
      return host;
    }
    return `${host}:${port}`;
  }
  return authority;
}

/**
 * Quotes one shell argument.
 *
 * A value made only of URL-safe characters is passed through; anything else is
 * wrapped in single quotes with the standard `'\''` escape, which is what the
 * connector CLI expects.
 */
export function quotePairingArgument(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** `uvx anywhere-cli pair <address>` — the command the user runs to pair. */
export function devicePairingCommand(serverUrl: string): string {
  return `uvx anywhere-cli pair ${quotePairingArgument(pairingServerAddress(serverUrl))}`;
}

/** `uvx anywhere-cli start …` — the command that starts a connector directly. */
export function deviceTokenCommand(credential: DeviceSetupCredential): string {
  const parts: string[] = [
    'uvx anywhere-cli start',
    `--server-url ${quotePairingArgument(credential.serverUrl)}`,
    `--connector-id ${quotePairingArgument(credential.device.id)}`,
    `--connector-token ${quotePairingArgument(credential.connectorToken)}`,
  ];
  return parts.join(' ');
}

const PAIRING_ADJECTIVES: string[] = [
  'amber', 'azure', 'brisk', 'calm', 'clear', 'clever', 'copper', 'crisp', 'deft', 'eager',
  'fair', 'fleet', 'fresh', 'gentle', 'golden', 'happy', 'honest', 'jade', 'keen', 'lively',
  'lucky', 'lunar', 'mellow', 'nimble', 'noble', 'opal', 'quiet', 'rapid', 'silver', 'smart',
  'solar', 'steady', 'swift', 'tidy', 'vivid', 'warm', 'witty', 'zesty', 'bright', 'cosmic',
];

const PAIRING_NOUNS: string[] = [
  'acorn', 'anchor', 'badger', 'bamboo', 'beacon', 'birch', 'brook', 'cedar', 'clover', 'comet',
  'condor', 'cove', 'falcon', 'finch', 'fjord', 'forest', 'garden', 'grove', 'harbor', 'heron',
  'island', 'juniper', 'lagoon', 'lantern', 'maple', 'meadow', 'meteor', 'nebula', 'otter', 'phoenix',
  'quartz', 'raven', 'ridge', 'river', 'rocket', 'sequoia', 'sparrow', 'summit', 'willow', 'zephyr',
];

/** A friendly default device name, as Android's `randomPairingDeviceName`. */
export function randomPairingDeviceName(): string {
  const adjective: string = PAIRING_ADJECTIVES[Math.floor(Math.random() * PAIRING_ADJECTIVES.length)];
  const noun: string = PAIRING_NOUNS[Math.floor(Math.random() * PAIRING_NOUNS.length)];
  return `${adjective}-${noun}`;
}

/** True when a pair code is complete; the claim button's gate. */
export function isCompletePairCode(code: string): boolean {
  return code.length === 6;
}

/** Keeps only digits, capped at six, matching the code field's filter. */
export function sanitizePairCode(value: string): string {
  let digits: string = '';
  for (const character of value) {
    if (character >= '0' && character <= '9' && digits.length < 6) {
      digits += character;
    }
  }
  return digits;
}
