import { RemoteRuntimeNotice, RemoteRuntimeNoticeAction } from '../../../api/RuntimeDtos';
import {
  CoercedInput, NoticeActionIcon, NoticeActionLabelKind, RuntimeInputRequestDraft,
  RuntimeInputRequestForm, RuntimeInputRequestOption, RuntimeInputRequestQuestion,
  RuntimeNoticeInputField, actionInputFields, coerceActionInput, encodeInputFormAnswers,
  initialInputDrafts, inputFormIsComplete, isDestructiveNotice, noticeActionIcon,
  noticeActionLabelKind, noticeActionServerLabel, noticeInputRequestForm, sortedNoticeActions,
} from '../../../feature/sessiondetail/SessionNoticePresentation';
import { AAColors, AA_LIGHT_COLORS, withAlpha } from '../../designsystem/AAColors';
import { AAIcon } from '../../designsystem/AAIcon';
import { AA_ICONS } from '../../designsystem/AAIcons';
import { AAFontSize, AARadius } from '../../designsystem/AAMetrics';

/**
 * Approval and input-request cards.
 *
 * Port of `ui/screens/sessiondetail/SessionRuntimeControls.kt`.
 *
 * These are the highest-priority surface in the app: a session waiting on an
 * approval is stopped until the user answers, so the card is reproduced closely,
 * including the details that are easy to skip:
 *
 *  - destructive answers sort first, so Deny is never the accidental default;
 *  - a small set of field-less actions on the composer-adjacent card collapses
 *    into icon buttons, and anything else becomes a labelled button row;
 *  - a structured input request renders its questions as selectable options,
 *    with the "Other" escape hatch only when the Server allows it.
 */

/** One field's raw text while the user types. */
interface FieldValue {
  key: string;
  value: string;
}

@Component
export struct RuntimeNoticeCard {
  colors: AAColors = AA_LIGHT_COLORS;
  notice: RemoteRuntimeNotice = EMPTY_NOTICE;
  busy: boolean = false;
  /** Set when the whole session cannot accept an answer right now. */
  actionsDisabled: boolean = false;
  errorMessage: string = '';
  /** Composer-adjacent cards use the raised surface and a larger radius. */
  composerAdjacent: boolean = false;
  compact: boolean = false;
  notificationOnly: boolean = false;
  onRespond: (actionId: string, input: Object | null) => void = () => {};

  @State private fieldValues: FieldValue[] = [];
  @State private selectedActionId: string = '';
  @State private validationError: string = '';
  @State private draftRevision: number = 0;
  private drafts: Map<string, RuntimeInputRequestDraft> = new Map();

  aboutToAppear(): void {
    const form: RuntimeInputRequestForm | null = noticeInputRequestForm(this.notice);
    if (form !== null) {
      this.drafts = initialInputDrafts(form);
    }
    this.resetFieldValues();
  }

  private form(): RuntimeInputRequestForm | null {
    return noticeInputRequestForm(this.notice);
  }

  private destructive(): boolean {
    return isDestructiveNotice(this.notice);
  }

  private cardRadius(): number {
    if (this.composerAdjacent) {
      return AARadius.BUBBLE;
    }
    return this.compact ? 12 : 16;
  }

  private cardBackground(): string {
    if (this.composerAdjacent) {
      return this.colors.raisedSurface;
    }
    if (this.destructive()) {
      return withAlpha(this.colors.errorIcon, 0.06);
    }
    if (this.notice.severity === 'warning' || this.notice.severity === 'success') {
      return withAlpha(this.accent(), 0.05);
    }
    return this.colors.canvas;
  }

  private accent(): string {
    if (this.notice.severity === 'warning') {
      return this.colors.noticeWarning;
    }
    if (this.notice.severity === 'success') {
      return this.colors.noticeSuccess;
    }
    return this.colors.border;
  }

  private headerIcon(): string {
    if (this.destructive()) {
      return AA_ICONS.CIRCLE_ALERT;
    }
    if (this.notificationOnly && this.notice.severity === 'warning') {
      return AA_ICONS.CIRCLE_ALERT;
    }
    if (this.notificationOnly && this.notice.severity === 'success') {
      return AA_ICONS.CIRCLE_CHECK;
    }
    if (this.notificationOnly) {
      return AA_ICONS.INFO;
    }
    return AA_ICONS.CIRCLE_CHECK;
  }

  private actionsLocked(): boolean {
    return this.actionsDisabled
      || this.busy
      || this.notice.status === 'response_accepted'
      || this.notice.status === 'resolving';
  }

  /** Icon buttons in the header replace the button row for a few simple actions. */
  private useHeaderIconActions(ordered: RemoteRuntimeNoticeAction[]): boolean {
    if (!this.composerAdjacent || this.form() !== null || ordered.length === 0
      || ordered.length > 3) {
      return false;
    }
    for (const action of ordered) {
      if (actionInputFields(action).length > 0) {
        return false;
      }
    }
    return true;
  }

  private resetFieldValues(): void {
    const values: FieldValue[] = [];
    for (const action of this.notice.actions) {
      for (const field of actionInputFields(action)) {
        values.push({ key: `${action.actionId}:${field.key}`, value: '' });
      }
    }
    this.fieldValues = values;
  }

  private fieldValue(actionId: string, key: string): string {
    const composite: string = `${actionId}:${key}`;
    for (const entry of this.fieldValues) {
      if (entry.key === composite) {
        return entry.value;
      }
    }
    return '';
  }

  private setFieldValue(actionId: string, key: string, value: string): void {
    const composite: string = `${actionId}:${key}`;
    const next: FieldValue[] = [];
    let replaced: boolean = false;
    for (const entry of this.fieldValues) {
      if (entry.key === composite) {
        next.push({ key: composite, value: value });
        replaced = true;
      } else {
        next.push(entry);
      }
    }
    if (!replaced) {
      next.push({ key: composite, value: value });
    }
    this.fieldValues = next;
  }

  /** Collects one action's field values into a map for validation. */
  private rawValuesFor(action: RemoteRuntimeNoticeAction): Map<string, string> {
    const values: Map<string, string> = new Map();
    for (const field of actionInputFields(action)) {
      values.set(field.key, this.fieldValue(action.actionId, field.key));
    }
    return values;
  }

  private submitAction(action: RemoteRuntimeNoticeAction): void {
    if (this.actionsLocked()) {
      return;
    }
    const form: RuntimeInputRequestForm | null = this.form();
    if (form !== null && form.action.actionId === action.actionId) {
      if (!inputFormIsComplete(form, this.drafts)) {
        this.validationError = 'Answer every question before submitting.';
        return;
      }
      this.validationError = '';
      this.onRespond(action.actionId, encodeInputFormAnswers(form, this.drafts));
      return;
    }
    const coerced: CoercedInput = coerceActionInput(action, this.rawValuesFor(action));
    if (coerced.error !== null) {
      this.validationError = coerced.error;
      return;
    }
    this.validationError = '';
    this.onRespond(action.actionId, coerced.input);
  }

  build() {
    Column({ space: 10 }) {
      Row({ space: 10 }) {
        AAIcon({
          commands: this.headerIcon(),
          iconSize: 17,
          color: this.destructive() ? this.colors.errorIcon : this.accent(),
        })
        Column({ space: 3 }) {
          Text(this.notice.title.length > 0
            ? this.notice.title
            : $r('app.string.session_approval_fallback', this.notice.interactionType ?? 'tool'))
            .fontSize(AAFontSize.LABEL)
            .fontWeight(FontWeight.Bold)
            .fontColor(this.colors.ink)
            .width('100%')
          if (this.notice.message !== null && this.notice.message.length > 0) {
            Text(this.notice.message)
              .fontSize(13)
              .fontColor(this.colors.muted)
              .lineHeight(18)
              .width('100%')
          }
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)

        if (this.useHeaderIconActions(sortedNoticeActions(this.notice))) {
          Row({ space: 6 }) {
            ForEach(sortedNoticeActions(this.notice), (action: RemoteRuntimeNoticeAction) => {
              this.IconActionButton(action)
            }, (action: RemoteRuntimeNoticeAction) => `icon-${action.actionId}`)
          }
        }
      }
      .width('100%')
      .alignItems(VerticalAlign.Top)

      // Structured input request: one block of options per question.
      if (this.form() !== null) {
        this.InputRequestForm(this.form()!)
      } else if (!this.useHeaderIconActions(sortedNoticeActions(this.notice))) {
        this.ActionButtons(sortedNoticeActions(this.notice))
      }

      // Field-based actions reveal their inputs once chosen.
      if (this.selectedActionId.length > 0 && this.form() === null) {
        this.ActionFields(this.selectedAction())
      }

      if (this.validationError.length > 0 || this.errorMessage.length > 0) {
        Text(this.validationError.length > 0 ? this.validationError : this.errorMessage)
          .fontSize(12.5)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.colors.errorText)
          .width('100%')
      }
    }
    .width('100%')
    .padding({ left: 14, right: 14, top: 12, bottom: 12 })
    .borderRadius(this.cardRadius())
    .backgroundColor(this.cardBackground())
    .border(this.composerAdjacent
      ? { width: 0 }
      : {
        width: 1,
        color: this.notice.severity === 'info' ? this.colors.border : withAlpha(this.accent(), 0.32),
      })
  }

  private selectedAction(): RemoteRuntimeNoticeAction | null {
    for (const action of this.notice.actions) {
      if (action.actionId === this.selectedActionId) {
        return action;
      }
    }
    return null;
  }

  @Builder
  IconActionButton(action: RemoteRuntimeNoticeAction) {
    Column() {
      AAIcon({
        commands: this.actionIconCommands(action),
        iconSize: 17,
        color: this.actionContentColor(action),
      })
    }
    .width(32)
    .height(32)
    .justifyContent(FlexAlign.Center)
    .borderRadius(16)
    .backgroundColor(this.actionBackground(action))
    .opacity(this.actionsLocked() ? 0.28 : 1)
    .onClick(() => this.submitAction(action))
  }

  @Builder
  ActionButtons(ordered: RemoteRuntimeNoticeAction[]) {
    Row({ space: 8 }) {
      ForEach(ordered, (action: RemoteRuntimeNoticeAction) => {
        Text(this.actionLabel(action))
          .fontSize(AAFontSize.SMALL)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.actionContentColor(action))
          .textAlign(TextAlign.Center)
          .constraintSize({ minHeight: 34 })
          .padding({ left: 14, right: 14, top: 8, bottom: 8 })
          .borderRadius(AARadius.PILL)
          .backgroundColor(this.actionBackground(action))
          .opacity(this.actionsLocked() ? 0.28 : 1)
          .onClick(() => {
            if (actionInputFields(action).length > 0) {
              this.selectedActionId = action.actionId;
              return;
            }
            this.submitAction(action);
          })
      }, (action: RemoteRuntimeNoticeAction) => `action-${action.actionId}`)
    }
    .width('100%')
  }

  @Builder
  ActionFields(action: RemoteRuntimeNoticeAction | null) {
    Column({ space: 8 }) {
      if (action !== null) {
        ForEach(actionInputFields(action), (field: RuntimeNoticeInputField) => {
          Column({ space: 4 }) {
            Text(field.label)
              .fontSize(12)
              .fontColor(this.colors.muted)
              .width('100%')
            TextInput({ text: this.fieldValue(action.actionId, field.key) })
              .fontSize(AAFontSize.BODY)
              .fontColor(this.colors.ink)
              .backgroundColor(this.colors.subtle)
              .borderRadius(10)
              .height(44)
              .onChange((next: string) => {
                this.setFieldValue(action.actionId, field.key, next);
              })
          }
          .width('100%')
          .alignItems(HorizontalAlign.Start)
        }, (field: RuntimeNoticeInputField) => `field-${action.actionId}-${field.key}`)

        Text($r('app.string.session_notice_submit'))
          .fontSize(AAFontSize.SMALL)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.colors.onPrimaryAction)
          .textAlign(TextAlign.Center)
          .height(36)
          .padding({ left: 16, right: 16 })
          .borderRadius(AARadius.PILL)
          .backgroundColor(this.colors.primaryAction)
          .opacity(this.actionsLocked() ? 0.28 : 1)
          .onClick(() => this.submitAction(action))
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  /**
   * The structured form: each question renders its options as selectable rows,
   * plus an "Other" row with an inline field when the Server allows one.
   */
  @Builder
  InputRequestForm(form: RuntimeInputRequestForm) {
    Column({ space: 16 }) {
      ForEach(form.questions, (question: RuntimeInputRequestQuestion) => {
        Column({ space: 8 }) {
          if (question.header !== null && question.header.length > 0) {
            Text(question.header)
              .fontSize(AAFontSize.SMALL)
              .fontWeight(FontWeight.Medium)
              .fontColor(this.colors.muted)
              .width('100%')
          }
          Text(question.prompt)
            .fontSize(AAFontSize.LABEL)
            .fontWeight(FontWeight.Medium)
            .fontColor(this.colors.ink)
            .lineHeight(19)
            .width('100%')

          ForEach(question.options, (option: RuntimeInputRequestOption) => {
            this.OptionRow(question, option.id, option.label, option.description)
          }, (option: RuntimeInputRequestOption) => `option-${question.id}-${option.id}`)

          if (question.allowCustom) {
            this.CustomOptionRow(question)
          }
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
      }, (question: RuntimeInputRequestQuestion) => `question-${question.id}`)

      Text($r('app.string.session_notice_submit'))
        .fontSize(AAFontSize.SMALL)
        .fontWeight(FontWeight.Bold)
        .fontColor(this.colors.onPrimaryAction)
        .textAlign(TextAlign.Center)
        .height(36)
        .padding({ left: 16, right: 16 })
        .borderRadius(AARadius.PILL)
        .backgroundColor(this.colors.primaryAction)
        .opacity(this.actionsLocked() ? 0.28 : 1)
        .onClick(() => this.submitAction(form.action))
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .constraintSize({ maxHeight: 420 })
  }

  @Builder
  OptionRow(
    question: RuntimeInputRequestQuestion,
    optionId: string,
    label: string,
    description: string | null,
  ) {
    Row({ space: 10 }) {
      // Single-select uses a circle, multi-select a rounded square.
      Column()
        .width(20)
        .height(20)
        .borderRadius(question.multiple ? 6 : 10)
        .backgroundColor(this.isSelected(question, optionId)
          ? this.colors.sessionStatusAccent
          : '#00000000')
        .border({ width: 1.5, color: this.isSelected(question, optionId)
          ? this.colors.sessionStatusAccent
          : this.colors.border })
      Column({ space: 2 }) {
        Text(label)
          .fontSize(13)
          .fontWeight(FontWeight.Medium)
          .fontColor(this.colors.ink)
          .width('100%')
        if (description !== null && description.length > 0) {
          Text(description)
            .fontSize(AAFontSize.SMALL)
            .fontColor(this.colors.muted)
            .width('100%')
        }
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .padding({ left: 10, right: 10, top: 8, bottom: 8 })
    .borderRadius(12)
    .backgroundColor(this.isSelected(question, optionId)
      ? this.colors.subtle
      : withAlpha(this.colors.subtle, 0.68))
    .alignItems(VerticalAlign.Center)
    .onClick(() => this.toggleOption(question, optionId))
  }

  @Builder
  CustomOptionRow(question: RuntimeInputRequestQuestion) {
    Column({ space: 6 }) {
      Row({ space: 10 }) {
        Column()
          .width(20)
          .height(20)
          .borderRadius(question.multiple ? 6 : 10)
          .backgroundColor(this.customSelected(question) ? this.colors.sessionStatusAccent : '#00000000')
          .border({ width: 1.5, color: this.customSelected(question)
            ? this.colors.sessionStatusAccent
            : this.colors.border })
        Text($r('app.string.session_input_request_other'))
          .fontSize(13)
          .fontWeight(FontWeight.Medium)
          .fontColor(this.colors.ink)
          .layoutWeight(1)
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)
      .onClick(() => this.selectCustom(question))

      if (this.customSelected(question)) {
        TextInput({ text: this.draftFor(question).customText })
          .fontSize(13)
          .fontColor(this.colors.ink)
          .backgroundColor(this.colors.subtle)
          .borderRadius(10)
          .height(40)
          .onChange((next: string) => {
            const draft: RuntimeInputRequestDraft = this.draftFor(question);
            draft.customText = next;
            this.draftRevision += 1;
          })
      }
    }
    .width('100%')
    .padding({ left: 10, right: 10, top: 8, bottom: 8 })
    .borderRadius(12)
    .backgroundColor(this.customSelected(question)
      ? this.colors.subtle
      : withAlpha(this.colors.subtle, 0.68))
  }

  private draftFor(question: RuntimeInputRequestQuestion): RuntimeInputRequestDraft {
    let draft: RuntimeInputRequestDraft | undefined = this.drafts.get(question.id);
    if (draft === undefined) {
      draft = new RuntimeInputRequestDraft();
      this.drafts.set(question.id, draft);
    }
    return draft;
  }

  private isSelected(question: RuntimeInputRequestQuestion, optionId: string): boolean {
    return this.draftFor(question).optionIds.includes(optionId);
  }

  private customSelected(question: RuntimeInputRequestQuestion): boolean {
    return this.draftFor(question).useCustom;
  }

  private toggleOption(question: RuntimeInputRequestQuestion, optionId: string): void {
    const draft: RuntimeInputRequestDraft = this.draftFor(question);
    if (question.multiple) {
      const next: string[] = [];
      let removed: boolean = false;
      for (const id of draft.optionIds) {
        if (id === optionId) {
          removed = true;
        } else {
          next.push(id);
        }
      }
      if (!removed) {
        next.push(optionId);
      }
      draft.optionIds = next;
      // Choosing a real option clears a custom answer unless multi-select.
      if (!question.multiple) {
        draft.useCustom = false;
      }
    } else {
      draft.optionIds = [optionId];
      draft.useCustom = false;
    }
    this.validationError = '';
    this.draftRevision += 1;
  }

  private selectCustom(question: RuntimeInputRequestQuestion): void {
    const draft: RuntimeInputRequestDraft = this.draftFor(question);
    draft.useCustom = true;
    if (!question.multiple) {
      draft.optionIds = [];
    }
    this.validationError = '';
    this.draftRevision += 1;
  }

  private actionLabel(action: RemoteRuntimeNoticeAction): ResourceStr {
    const kind: NoticeActionLabelKind = noticeActionLabelKind(action);
    if (kind === NoticeActionLabelKind.Approve) {
      return $r('app.string.session_approval_approve');
    }
    if (kind === NoticeActionLabelKind.ApproveSession) {
      return $r('app.string.session_approval_approve_session');
    }
    if (kind === NoticeActionLabelKind.Deny) {
      return $r('app.string.session_approval_deny');
    }
    if (kind === NoticeActionLabelKind.Cancel) {
      return $r('app.string.common_cancel');
    }
    if (kind === NoticeActionLabelKind.Submit) {
      return $r('app.string.session_input_request_submit');
    }
    return noticeActionServerLabel(action);
  }

  private actionIconCommands(action: RemoteRuntimeNoticeAction): string {
    const icon: NoticeActionIcon = noticeActionIcon(action);
    if (icon === NoticeActionIcon.X) {
      return AA_ICONS.X;
    }
    if (icon === NoticeActionIcon.Shield) {
      return AA_ICONS.CIRCLE_CHECK;
    }
    return AA_ICONS.CHECK;
  }

  private actionContentColor(action: RemoteRuntimeNoticeAction): string {
    const kind: NoticeActionLabelKind = noticeActionLabelKind(action);
    if (kind === NoticeActionLabelKind.Deny) {
      return this.colors.errorText;
    }
    if (kind === NoticeActionLabelKind.Approve || kind === NoticeActionLabelKind.ApproveSession) {
      return this.colors.onPrimaryAction;
    }
    return this.colors.inkSoft;
  }

  private actionBackground(action: RemoteRuntimeNoticeAction): string {
    const kind: NoticeActionLabelKind = noticeActionLabelKind(action);
    if (kind === NoticeActionLabelKind.Deny) {
      return withAlpha(this.colors.errorText, 0.1);
    }
    if (kind === NoticeActionLabelKind.Approve || kind === NoticeActionLabelKind.ApproveSession) {
      return this.colors.primaryAction;
    }
    return this.colors.secondaryActionSurface;
  }
}

/**
 * The stack of blocking notices shown above the composer.
 *
 * Only notices that name the current session as blocked appear. Up to three
 * backing cards are drawn behind the active one with Android's offsets so the
 * user can see there is more than one request waiting.
 */
@Component
export struct BlockingRuntimeNoticeStack {
  colors: AAColors = AA_LIGHT_COLORS;
  notices: RemoteRuntimeNotice[] = [];
  busy: boolean = false;
  onRespond: (noticeId: string, actionId: string, input: Object | null) => void = () => {};

  /** The active notice: highest `updatedSeq`, then id, matching Android. */
  private activeNotice(): RemoteRuntimeNotice | null {
    if (this.notices.length === 0) {
      return null;
    }
    let active: RemoteRuntimeNotice = this.notices[0];
    for (const notice of this.notices) {
      if (notice.updatedSeq > active.updatedSeq
        || (notice.updatedSeq === active.updatedSeq && notice.noticeId > active.noticeId)) {
        active = notice;
      }
    }
    return active;
  }

  private backingNotices(): RemoteRuntimeNotice[] {
    const active: RemoteRuntimeNotice | null = this.activeNotice();
    if (active === null) {
      return [];
    }
    const backing: RemoteRuntimeNotice[] = [];
    for (const notice of this.notices) {
      if (notice.noticeId !== active.noticeId && backing.length < 3) {
        backing.push(notice);
      }
    }
    return backing;
  }

  build() {
    Column() {
      if (this.activeNotice() !== null) {
        Stack({ alignContent: Alignment.Bottom }) {
          // Backing cards, furthest first so the nearest paints on top.
          ForEach(this.backingNotices(), (notice: RemoteRuntimeNotice, index: number) => {
            Column()
              .width('100%')
              .height(64)
              .borderRadius(16)
              .backgroundColor(this.colors.raisedSurface)
              .translate({ y: -7 * (index + 1) })
              .scale({ x: 1 - 0.014 * (index + 1), y: 1 - 0.014 * (index + 1) })
              .opacity(1 - 0.16 * (index + 1))
          }, (notice: RemoteRuntimeNotice) => `backing-${notice.noticeId}`)

          RuntimeNoticeCard({
            colors: this.colors,
            notice: this.activeNotice()!,
            busy: this.busy,
            composerAdjacent: true,
            onRespond: (actionId: string, input: Object | null) => {
              this.onRespond(this.activeNotice()!.noticeId, actionId, input);
            },
          })
        }
        .width('100%')
        .margin({ top: 14 })
      }
    }
    .width('100%')
    .padding({ left: 14, right: 14 })
  }
}

const EMPTY_NOTICE: RemoteRuntimeNotice = {
  noticeId: '',
  type: 'unknown',
  sessionId: '',
  source: JSON.parse('{}') as Object,
  title: '',
  message: null,
  severity: 'info',
  status: 'open',
  interactionType: null,
  blocking: null,
  responseRequired: false,
  actions: [],
  context: JSON.parse('{}') as Object,
  metadata: JSON.parse('{}') as Object,
  expiresAt: null,
  revision: 1,
  updatedSeq: 0,
  createdAt: null,
  updatedAt: null,
  resolvedAt: null,
};
