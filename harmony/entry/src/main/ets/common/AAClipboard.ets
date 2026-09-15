import { pasteboard } from '@kit.BasicServicesKit';
import { AALog } from './AAAppLog';

/**
 * System clipboard.
 *
 * Android writes to the clipboard through Compose's `LocalClipboardManager`; on
 * HarmonyOS the equivalent is the system pasteboard service. Nothing here needs a
 * permission: writing plain text is unprivileged, and only reading requires
 * `ohos.permission.READ_PASTEBOARD`.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (text.length === 0) {
    return false;
  }
  try {
    const data: pasteboard.PasteData =
      pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, text);
    await pasteboard.getSystemPasteboard().setData(data);
    return true;
  } catch (error) {
    AALog.warn(`Clipboard write failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return false;
  }
}
