import { normalizeServerOrigin } from 'common';
import {
  objGetOptString,
  objGetString,
  parseJsonRecord
} from 'common';

/**
 * Payload encoded in the mobile sign-in QR shown by the desktop / web client.
 * Mirrors `parseMobileLoginQrPayload` in the Android client.
 */
export class MobileLoginQrPayload {
  readonly serverUrl: string;
  readonly userId: string;
  readonly loginToken: string;
  readonly expiresAt: string;

  constructor(serverUrl: string, userId: string, loginToken: string, expiresAt: string) {
    this.serverUrl = serverUrl;
    this.userId = userId;
    this.loginToken = loginToken;
    this.expiresAt = expiresAt;
  }
}

export function parseMobileLoginQrPayload(qrValue: string): MobileLoginQrPayload | null {
  let record: Record<string, Object>;
  try {
    record = parseJsonRecord(qrValue);
  } catch (error) {
    return null;
  }
  if (objGetString(record, 'type', '') !== 'agents-anywhere.mobile-login') {
    return null;
  }
  const rawServerUrl = objGetOptString(record, 'serverUrl') ?? objGetOptString(record, 'webUrl') ?? '';
  const serverUrl = normalizeServerOrigin(rawServerUrl);
  if (serverUrl === null) {
    return null;
  }
  const userId = objGetOptString(record, 'userId');
  const loginToken = objGetOptString(record, 'loginToken');
  if (userId === null || loginToken === null) {
    return null;
  }
  const expiresAt = objGetOptString(record, 'expiresAt');
  return new MobileLoginQrPayload(serverUrl, userId, loginToken, expiresAt === null ? '' : expiresAt);
}
