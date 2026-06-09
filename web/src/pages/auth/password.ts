export function passwordScore(pw: string): number {
  if (!pw) return 0;
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) s++;
  return Math.min(s, 4);
}

export const STRENGTH_LABEL = ["Too short", "Weak", "Fair", "Good", "Strong"];

// Aligned with backend store.normalize_user_id: [a-z0-9_-]{3,32}, lowercased.
export const USER_ID_RE = /^[a-z0-9_-]{3,32}$/;
export const USER_ID_HINT = "3–32 chars · a-z 0-9 _ -";
