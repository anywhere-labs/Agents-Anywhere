// Mirrors android/app/src/main/java/com/agentsanywhere/app/feature/devices/DevicePairingFlow.kt
// Pairing step machine, CLI command builders, and the pairing online monitor.
// Steps: 0 ConnectionMethod, 1 DesktopInstall, 2 CliConfirm, 3 Name,
// 4 CliMethod, 5 Command, 6 PairCode.

export const PAIRING_STEP_CONNECTION = 0;
export const PAIRING_STEP_DESKTOP_INSTALL = 1;
export const PAIRING_STEP_CLI_CONFIRM = 2;
export const PAIRING_STEP_NAME = 3;
export const PAIRING_STEP_CLI_METHOD = 4;
export const PAIRING_STEP_COMMAND = 5;
export const PAIRING_STEP_PAIR_CODE = 6;

export function pairingStepPrevious(step: number): number {
  if (step === PAIRING_STEP_COMMAND || step === PAIRING_STEP_PAIR_CODE) {
    return PAIRING_STEP_CLI_METHOD;
  }
  if (step === PAIRING_STEP_CLI_METHOD) {
    return PAIRING_STEP_NAME;
  }
  return PAIRING_STEP_CONNECTION;
}

// Quote a shell argument: plain values stay bare, others are single-quoted
// with embedded single quotes escaped ('\''). Mirrors quotePairingArgument.
export function quotePairingArgument(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) {
    return value;
  }
  return "'" + value.replace("'", "'\\''") + "'";
}

// uvx anywhere-cli pair <server address> — shown in the PairCode step.
export function devicePairingCommand(serverUrl: string): string {
  let address = serverUrl;
  const lowered = serverUrl.toLowerCase();
  if (lowered.startsWith('https://')) {
    const rest = serverUrl.substring('https://'.length);
    let host = rest;
    let portText = '';
    if (rest.startsWith('[')) {
      const closeIndex = rest.indexOf(']');
      if (closeIndex >= 0) {
        host = rest.substring(0, closeIndex + 1);
        const after = rest.substring(closeIndex + 1);
        if (after.startsWith(':')) {
          portText = after.substring(1);
        }
      }
    } else {
      const colonIndex = rest.lastIndexOf(':');
      if (colonIndex >= 0) {
        host = rest.substring(0, colonIndex);
        portText = rest.substring(colonIndex + 1);
      }
    }
    if (host.length > 0) {
      address = portText.length > 0 ? `${host}:${portText}` : host;
    }
  } else if (lowered.startsWith('http://')) {
    const rest = serverUrl.substring('http://'.length);
    let host = rest;
    let portText = '';
    if (rest.startsWith('[')) {
      const closeIndex = rest.indexOf(']');
      if (closeIndex >= 0) {
        host = rest.substring(0, closeIndex + 1);
        const after = rest.substring(closeIndex + 1);
        if (after.startsWith(':')) {
          portText = after.substring(1);
        }
      }
    } else {
      const slashIndex = rest.indexOf('/');
      const authority = slashIndex >= 0 ? rest.substring(0, slashIndex) : rest;
      const colonIndex = authority.lastIndexOf(':');
      if (colonIndex >= 0) {
        host = authority.substring(0, colonIndex);
        portText = authority.substring(colonIndex + 1);
      } else {
        host = authority;
      }
    }
    if (host.length > 0) {
      address = portText.length > 0 ? `${host}:${portText}` : host;
    }
  }
  return `uvx anywhere-cli pair ${quotePairingArgument(address)}`;
}

export interface DeviceSetupCredential {
  deviceId: string;
  deviceName: string;
  serverUrl: string;
  connectorToken: string;
}

// uvx anywhere-cli start --server-url … --connector-id … --connector-token …
export function deviceTokenCommand(credential: DeviceSetupCredential): string {
  const parts: string[] = [
    'uvx anywhere-cli start',
    `--server-url ${quotePairingArgument(credential.serverUrl)}`,
    `--connector-id ${quotePairingArgument(credential.deviceId)}`,
    `--connector-token ${quotePairingArgument(credential.connectorToken)}`
  ];
  return parts.join(' ');
}

const ADJECTIVES: string[] = [
  'amber', 'azure', 'brisk', 'calm', 'clear', 'clever', 'copper', 'crisp', 'deft', 'eager',
  'fair', 'fleet', 'fresh', 'gentle', 'golden', 'happy', 'honest', 'jade', 'keen', 'lively',
  'lucky', 'lunar', 'mellow', 'nimble', 'noble', 'opal', 'quiet', 'rapid', 'silver', 'smart',
  'solar', 'steady', 'swift', 'tidy', 'vivid', 'warm', 'witty', 'zesty', 'bright', 'cosmic'
];

const NOUNS: string[] = [
  'acorn', 'anchor', 'badger', 'bamboo', 'beacon', 'birch', 'brook', 'cedar', 'clover', 'comet',
  'condor', 'cove', 'falcon', 'finch', 'fjord', 'forest', 'garden', 'grove', 'harbor', 'heron',
  'island', 'juniper', 'lagoon', 'lantern', 'maple', 'meadow', 'meteor', 'nebula', 'otter', 'phoenix',
  'quartz', 'raven', 'ridge', 'river', 'rocket', 'sequoia', 'sparrow', 'summit', 'willow', 'zephyr'
];

export function randomPairingDeviceName(): string {
  const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adjective}-${noun}`;
}

export interface DeviceLookupResult {
  ok: boolean;
  online: boolean;
  fatal: boolean;
}

export type PairingDeviceLookup = (deviceId: string) => Promise<DeviceLookupResult>;

// Polls a newly created device until it reports online. Mirrors
// DevicePairingMonitor.observe: a definite non-retryable error (non-408/409/425/429
// status below 500) stops the wait; other failures back off 3s, successes 2s.
export class PairingMonitor {
  private readonly lookup: PairingDeviceLookup;
  private stopped: boolean = false;
  private timer: number = -1;

  constructor(lookup: PairingDeviceLookup) {
    this.lookup = lookup;
  }

  start(deviceId: string, onOnline: () => void, onStopped: (reason: string) => void): void {
    if (deviceId.length === 0) {
      return;
    }
    this.poll(deviceId, onOnline, onStopped);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer >= 0) {
      clearTimeout(this.timer);
      this.timer = -1;
    }
  }

  private async poll(deviceId: string, onOnline: () => void, onStopped: (reason: string) => void): Promise<void> {
    while (!this.stopped) {
      let result: DeviceLookupResult;
      try {
        result = await this.lookup(deviceId);
      } catch (error) {
        result = new LookupFailure();
      }
      if (this.stopped) {
        return;
      }
      if (result.online) {
        onOnline();
        return;
      }
      if (result.fatal) {
        onStopped('The pairing could not continue.');
        return;
      }
      const delayMs = result.ok ? 2000 : 3000;
      this.timer = setTimeout(() => {
        this.timer = -1;
        this.poll(deviceId, onOnline, onStopped);
      }, delayMs);
    }
  }
}

class LookupFailure implements DeviceLookupResult {
  ok: boolean = false;
  online: boolean = false;
  fatal: boolean = false;
}
