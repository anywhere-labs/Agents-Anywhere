import { ApiClient } from 'network';
import { AuthSessionStore } from '../auth/AuthSessionStore';

// Keep in sync with the @StorageLink key in pages/Index.ets.
const AUTH_SESSION_EXPIRED_KEY = 'authSessionExpiredTick';

export function notifyAuthSessionExpired(): void {
  AppStorage.setOrCreate(AUTH_SESSION_EXPIRED_KEY, Date.now());
}

export class SharedApiClient {
  private static instance: ApiClient | null = null;

  static getInstance(): ApiClient {
    if (SharedApiClient.instance === null) {
      const authStore = AuthSessionStore.getInstance();
      SharedApiClient.instance = new ApiClient((accessToken: string) => {
        if (authStore.clearAuthSessionIfTokenMatches(accessToken)) {
          notifyAuthSessionExpired();
        }
      });
    }
    return SharedApiClient.instance;
  }
}
