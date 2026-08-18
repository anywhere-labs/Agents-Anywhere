const NEW_SESSION_PERMISSION_KEY = "aa-new-session-default-permission-v1";

export function readNewSessionPermissionMode(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(NEW_SESSION_PERMISSION_KEY);
    return value && value.trim() ? value : null;
  } catch {
    return null;
  }
}

export function writeNewSessionPermissionMode(value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(NEW_SESSION_PERMISSION_KEY, value);
  } catch {
    // Ignore storage failures; the in-memory UI state still updates.
  }
}
