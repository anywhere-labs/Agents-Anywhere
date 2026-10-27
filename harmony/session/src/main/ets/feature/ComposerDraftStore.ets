import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { RemoteUploadedAttachment, parseRemoteUploadedAttachment } from 'network';
import { parseJsonRecord, recordsFromArray, objGetArray, objGetOptString } from 'common';

const PREF_NAME: string = 'composer-drafts';
const LOG_TAG: string = 'AgentsAnywhere.Draft';

/** One persisted composer state, restored by session id. */
export class ComposerDraftValue {
  readonly text: string;
  readonly attachments: RemoteUploadedAttachment[];

  constructor(text: string, attachments: RemoteUploadedAttachment[]) {
    this.text = text;
    this.attachments = attachments;
  }

  static empty(): ComposerDraftValue {
    return new ComposerDraftValue('', []);
  }

  isEmpty(): boolean {
    return this.text.trim().length === 0 && this.attachments.length === 0;
  }
}

function decodeDraft(raw: string): ComposerDraftValue {
  if (raw.length === 0) {
    return ComposerDraftValue.empty();
  }
  let record: Record<string, Object>;
  try {
    record = parseJsonRecord(raw);
  } catch (error) {
    return ComposerDraftValue.empty();
  }
  const text = objGetOptString(record, 'text');
  const attachments: RemoteUploadedAttachment[] = [];
  for (const item of recordsFromArray(objGetArray(record, 'attachments'))) {
    attachments.push(parseRemoteUploadedAttachment(item));
  }
  return new ComposerDraftValue(text === null ? '' : text, attachments);
}

/**
 * Persists what the user typed (and the attachments they already uploaded)
 * per session, so leaving the conversation or restarting the app does not
 * lose an unfinished message. Mirrors Android's SessionComposerDraftStore;
 * in-flight uploads are not modelled here because our pending attachments
 * are always already uploaded to the server when they enter the list.
 */
export class ComposerDraftStore {
  private static instance: ComposerDraftStore | null = null;
  private store: preferences.Preferences | null = null;
  private readyPromise: Promise<void> | null = null;

  static getInstance(): ComposerDraftStore {
    if (ComposerDraftStore.instance === null) {
      ComposerDraftStore.instance = new ComposerDraftStore();
    }
    return ComposerDraftStore.instance;
  }

  init(context: common.UIAbilityContext): void {
    if (this.readyPromise !== null) {
      return;
    }
    this.readyPromise = preferences.getPreferences(context, { name: PREF_NAME })
      .then((value: preferences.Preferences) => {
        this.store = value;
      })
      .catch((error: Error) => {
        hilog.error(0x0000, LOG_TAG, 'getPreferences failed: %{public}s', error.message);
      });
  }

  async waitUntilReady(): Promise<void> {
    const promise = this.readyPromise;
    if (promise !== null) {
      await promise;
    }
  }

  async load(sessionId: string): Promise<ComposerDraftValue> {
    if (sessionId.length === 0) {
      return ComposerDraftValue.empty();
    }
    await this.waitUntilReady();
    const store = this.store;
    if (store === null) {
      return ComposerDraftValue.empty();
    }
    try {
      const raw = store.getSync(sessionId, '') as string;
      return decodeDraft(raw);
    } catch (err) {
      hilog.error(0x0000, LOG_TAG, 'read draft failed: %{public}s', (err as Error).message);
      return ComposerDraftValue.empty();
    }
  }

  /** Stores a draft, or clears it when there is nothing left to keep. */
  save(sessionId: string, text: string, attachments: RemoteUploadedAttachment[]): void {
    if (sessionId.length === 0) {
      return;
    }
    const draft = new ComposerDraftValue(text, attachments);
    if (draft.isEmpty()) {
      this.clear(sessionId);
      return;
    }
    const store = this.store;
    if (store === null) {
      return;
    }
    try {
      const payload = JSON.stringify({ text: draft.text, attachments: draft.attachments });
      store.putSync(sessionId, payload);
      store.flush().catch((): void => {
      });
    } catch (err) {
      hilog.error(0x0000, LOG_TAG, 'save draft failed: %{public}s', (err as Error).message);
    }
  }

  clear(sessionId: string): void {
    if (sessionId.length === 0) {
      return;
    }
    const store = this.store;
    if (store === null) {
      return;
    }
    try {
      store.deleteSync(sessionId);
      store.flush().catch((): void => {
      });
    } catch (err) {
      hilog.error(0x0000, LOG_TAG, 'clear draft failed: %{public}s', (err as Error).message);
    }
  }
}
