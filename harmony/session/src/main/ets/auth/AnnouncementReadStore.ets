import { preferences } from '@kit.ArkData';
import { Context } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { announcementTimestamp, PublicAnnouncement } from 'network';

const STORE_NAME = 'announcement-read';
const LOG_TAG = 'AgentsAnywhere.Announcements';

export class AnnouncementReadStore {
  private static instance: AnnouncementReadStore | null = null;
  private store: preferences.Preferences | null = null;
  private readyPromise: Promise<void> | null = null;
  private initError: string = '';

  static getInstance(): AnnouncementReadStore {
    if (AnnouncementReadStore.instance === null) {
      AnnouncementReadStore.instance = new AnnouncementReadStore();
    }
    return AnnouncementReadStore.instance;
  }

  init(context: Context): void {
    if (this.readyPromise !== null) {
      return;
    }
    this.readyPromise = preferences.getPreferences(context, { name: STORE_NAME })
      .then((value: preferences.Preferences) => {
        this.store = value;
      })
      .catch((error: BusinessError) => {
        this.initError = error.message;
        hilog.error(0x0000, LOG_TAG, `getPreferences("${STORE_NAME}") failed: ${error.message}`);
      });
  }

  async waitUntilReady(): Promise<void> {
    const promise = this.readyPromise;
    if (promise !== null) {
      await promise;
    }
  }

  isUnread(serverUrl: string, announcement: PublicAnnouncement): boolean {
    if (announcement.markdown.trim().length === 0) {
      return false;
    }
    return announcementTimestamp(announcement.publishedAt) > this.readTimestamp(serverUrl);
  }

  markRead(serverUrl: string, announcement: PublicAnnouncement): void {
    if (!this.isUnread(serverUrl, announcement)) {
      return;
    }
    const store = this.requireStore();
    store.putSync(serverUrl, announcement.publishedAt);
    store.flush().catch(() => {
    });
  }

  private readTimestamp(serverUrl: string): number {
    const store = this.requireStore();
    const value = store.getSync(serverUrl, '');
    if (typeof value !== 'string' || value.length === 0) {
      return 0;
    }
    return announcementTimestamp(value);
  }

  private requireStore(): preferences.Preferences {
    const store = this.store;
    if (store === null) {
      if (this.initError.length > 0) {
        throw new Error(`Announcement storage failed to initialize: ${this.initError}`);
      }
      throw new Error('Announcement storage is not ready yet.');
    }
    return store;
  }
}
