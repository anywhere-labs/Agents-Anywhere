import type { UserRole } from "./api";

const KEY = "aa.session.v1";

export type StoredSession = {
  accessToken: string;
  userId: string;
  role: UserRole;
};

export function loadSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSession;
    if (!parsed?.accessToken || !parsed.userId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveSession(s: StoredSession) {
  localStorage.setItem(KEY, JSON.stringify(s));
}

export function clearSession() {
  localStorage.removeItem(KEY);
}
