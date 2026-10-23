import { promptAction } from '@kit.ArkUI';

/**
 * Show a brief, non-blocking toast message.
 *
 * Replacement for deprecated `AlertDialog.show` usage that only displayed an
 * informational message (no confirm/cancel action). The message is a plain
 * `promptAction.showToast` accepts a `$r(...)` Resource, so this accepts
 * `ResourceStr`; plain strings remain a valid subtype.
 *
 * Any failure (e.g. called before the UI context is ready) is swallowed so a
 * toast can never break the surrounding flow.
 */
export function showToast(message: ResourceStr): void {
  try {
    promptAction.showToast({ message, duration: 2000 });
  } catch (e) {
    // Ignore: showing a toast must never break the caller's flow.
  }
}
