import { util } from '@kit.ArkTS';
import { AAPreferenceNames, AAPreferenceStore } from './AAPreferences';

/**
 * The stable realtime client id.
 *
 * Ported from `RealtimeClientIdStore.kt`. One id per install, shared by the
 * dashboard and session sockets, and sent when minting a WebSocket ticket.
 *
 * The Android value is prefixed `android-`; this client uses `harmony-` so a
 * server operator can still tell which platform a connection came from. The
 * prefix is not validated by the Server, so the difference is safe.
 */
export class RealtimeClientIdStore {
  private readonly store: AAPreferenceStore;

  constructor() {
    this.store = new AAPreferenceStore(AAPreferenceNames.REALTIME);
  }

  private static readonly KEY_CLIENT_ID: string = 'client_id';

  /** Returns the stored id, creating and persisting one on first use. */
  clientId(): string {
    const existing: string = this.store.getString(RealtimeClientIdStore.KEY_CLIENT_ID, '');
    if (existing.length > 0) {
      return existing;
    }
    const created: string = `harmony-${util.generateRandomUUID(true)}`;
    this.store.setString(RealtimeClientIdStore.KEY_CLIENT_ID, created);
    return created;
  }
}
