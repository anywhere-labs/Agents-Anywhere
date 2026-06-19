import type { AuthResponse, StoredSession } from "@/features/auth/types";

const SESSION_KEY = "aa.session.v1";

export function authResponseToSession(auth: AuthResponse): StoredSession {
  return {
    accessToken: auth.accessToken,
    userId: auth.userId,
    role: auth.role
  };
}

export function loadStoredSession(): StoredSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (!parsed.accessToken || !parsed.userId || !parsed.role) return null;
    return {
      accessToken: parsed.accessToken,
      userId: parsed.userId,
      role: parsed.role
    };
  } catch {
    return null;
  }
}

export function saveStoredSession(session: StoredSession): void {
  window.localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearStoredSession(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(SESSION_KEY);
}
