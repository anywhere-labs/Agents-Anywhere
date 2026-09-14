import { AAColors, AA_LIGHT_COLORS, withAlpha } from '../../designsystem/AAColors';
import { ParsedAuthConfig, ParsedEmailCode } from '../../../api/AuthDtos';
import { resolveString, resolveText } from '../../../common/AAResources';

/**
 * The identity dialogs.
 *
 * Port of `ProfileSettingsDialogs.kt` and `ProfileIdentityDialogs.kt`.
 *
 * Android's `ProfileDialog` is a Material `Dialog` holding a 20dp-radius card
 * with an 18dp inset and 14dp between its children; ArkUI has no plain component
 * slot, so the frame takes its children through `@BuilderParam` and the four
 * dialogs are built on top of it. Every dialog is a scrim over the drawer, so it
 * is placed last inside the drawer's `Stack`.
 */

/** The shared card: title, then whatever the dialog adds. */
@Component
export struct ProfileDialogFrame {
  colors: AAColors = AA_LIGHT_COLORS;
  title: ResourceStr = '';
  /** Android's `Dialog(onDismissRequest)`: a tap on the scrim closes the dialog. */
  onDismiss: () => void = () => {};
  @BuilderParam content: () => void;

  build() {
    Column() {
      Column({ space: 14 }) {
        Text(this.title)
          .fontSize(20)
          .lineHeight(24)
          .fontWeight(600)
          .fontColor(this.colors.ink)
          .width('100%')

        this.content()
      }
      .width('100%')
      .padding(18)
      .borderRadius(20)
      .backgroundColor(this.colors.dialogSurface)
      .alignItems(HorizontalAlign.Start)
      // Consumes the tap so only the scrim dismisses the dialog.
      .onClick(() => {})
    }
    .width('100%')
    .height('100%')
    .padding({ left: 22, right: 22 })
    .justifyContent(FlexAlign.Center)
    .onClick(() => this.onDismiss())
  }
}

/**
 * A plain underlined field, as iOS forms use it.
 *
 * `AccountIdentitySettingsView` / `PasswordSettingsView` set
 * `.textFieldStyle(.plain)` inside a section: no fill, no border, 17pt text and a
 * divider underneath. This app keeps its dialogs, so the field keeps the
 * placeholder inside it but drops Android's 14dp boxed input.
 */
@Component
export struct ProfileTextField {
  colors: AAColors = AA_LIGHT_COLORS;
  fieldValue: string = '';
  placeholder: ResourceStr = '';
  password: boolean = false;
  onValueChange: (value: string) => void = () => {};

  build() {
    Stack({ alignContent: Alignment.Bottom }) {
      TextInput({ text: this.fieldValue, placeholder: this.placeholder })
        .type(this.password ? InputType.Password : InputType.Normal)
        .width('100%')
        .height(54)
        .padding({ top: 18, bottom: 18 })
        .fontSize(17)
        .fontColor(this.colors.ink)
        .placeholderColor(this.colors.faint)
        .backgroundColor('#00000000')
        .borderRadius(0)
        .caretColor(this.colors.ink)
        .onChange((value: string) => this.onValueChange(value))

      Divider().color(this.colors.border)
    }
    .width('100%')
  }
}

/** The error line under a field: 12.5sp semibold in the error colour. */
@Component
export struct ProfileDialogHint {
  colors: AAColors = AA_LIGHT_COLORS;
  text: string = '';

  build() {
    Text(this.text)
      .fontSize(12.5)
      .fontWeight(600)
      .fontColor(this.colors.errorText)
      .width('100%')
  }
}

/** A dialog button in the iOS capsules: 50dp, 17sp semibold, fully rounded. */
@Component
export struct ProfileDialogButton {
  colors: AAColors = AA_LIGHT_COLORS;
  label: ResourceStr = '';
  primary: boolean = false;
  /** Named `buttonEnabled` because `enabled` collides with the component modifier. */
  buttonEnabled: boolean = true;
  onTap: () => void = () => {};

  build() {
    Text(this.label)
      .fontSize(17)
      .fontWeight(600)
      .fontColor(this.primary ? this.colors.onPrimaryAction : this.colors.ink)
      .textAlign(TextAlign.Center)
      .layoutWeight(1)
      .height(50)
      .borderRadius(25)
      .backgroundColor(this.primary
        ? withAlpha(this.colors.primaryAction, this.buttonEnabled ? 1 : 0.42)
        : (this.colors.isDark ? '#0FFFFFFF' : '#0A000000'))
      .border(this.primary
        ? { width: 0 }
        : { width: 1, color: this.colors.isDark ? '#38FFFFFF' : '#24000000' })
      .onClick(() => {
        if (this.buttonEnabled) {
          this.onTap();
        }
      })
  }
}

/** Confirms signing out; the drawer's own copy of Android's sign-out dialog. */
@Component
export struct ConfirmSignOutDialog {
  colors: AAColors = AA_LIGHT_COLORS;
  onDismiss: () => void = () => {};
  onConfirm: () => void = () => {};

  build() {
    ProfileDialogFrame({
      colors: this.colors,
      title: $r('app.string.profile_sign_out_title'),
      onDismiss: () => this.onDismiss(),
    }) {
      Column({ space: 14 }) {
        Text($r('app.string.profile_sign_out_body'))
          .fontSize(14)
          .lineHeight(19)
          .fontColor(this.colors.muted)
          .width('100%')

        Row({ space: 10 }) {
          ProfileDialogButton({
            colors: this.colors,
            label: $r('app.string.common_cancel'),
            onTap: () => this.onDismiss(),
          })
          ProfileDialogButton({
            colors: this.colors,
            label: $r('app.string.profile_sign_out'),
            primary: true,
            onTap: () => this.onConfirm(),
          })
        }
        .width('100%')
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
    }
  }
}

/**
 * Edits the nickname.
 *
 * A name must be 1..64 characters once trimmed; the Server's message is shown in
 * place while the save runs.
 */
@Component
export struct NicknameDialog {
  colors: AAColors = AA_LIGHT_COLORS;
  displayName: string = '';
  onDismiss: () => void = () => {};
  onSave: (displayName: string) => Promise<string> = () => Promise.resolve('');

  @State private draft: string = '';
  @State private busy: boolean = false;
  @State private error: string = '';

  aboutToAppear(): void {
    this.draft = this.displayName;
  }

  private canSave(): boolean {
    const trimmed: string = this.draft.trim();
    return trimmed.length >= 1 && trimmed.length <= 64 && !this.busy;
  }

  build() {
    ProfileDialogFrame({
      colors: this.colors,
      title: $r('app.string.profile_edit_nickname'),
      onDismiss: () => this.onDismiss(),
    }) {
      Column({ space: 14 }) {
        ProfileTextField({
          colors: this.colors,
          fieldValue: this.draft,
          placeholder: $r('app.string.profile_nickname'),
          onValueChange: (value: string) => {
            if (!this.busy) {
              this.draft = value;
              this.error = '';
            }
          },
        })

        if (this.error.length > 0) {
          ProfileDialogHint({ colors: this.colors, text: this.error })
        }

        Row({ space: 10 }) {
          ProfileDialogButton({
            colors: this.colors,
            label: $r('app.string.common_cancel'),
            buttonEnabled: !this.busy,
            onTap: () => this.onDismiss(),
          })
          ProfileDialogButton({
            colors: this.colors,
            label: this.busy ? $r('app.string.common_saving') : $r('app.string.common_save'),
            primary: true,
            buttonEnabled: this.canSave(),
            onTap: () => {
              void this.save();
            },
          })
        }
        .width('100%')
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
    }
  }

  private async save(): Promise<void> {
    if (!this.canSave()) {
      return;
    }
    this.busy = true;
    try {
      const failure: string = await this.onSave(this.draft.trim());
      if (failure.length > 0) {
        this.error = failure;
      }
    } finally {
      this.busy = false;
    }
  }
}

/**
 * Changes the password.
 *
 * The rules are Android's: at least eight characters, both fields equal, and the
 * hint prefers the length problem while the first field is the one being typed.
 */
@Component
export struct ChangePasswordDialog {
  colors: AAColors = AA_LIGHT_COLORS;
  onDismiss: () => void = () => {};
  onSave: (password: string) => Promise<string> = () => Promise.resolve('');

  @State private password: string = '';
  @State private confirm: string = '';
  @State private busy: boolean = false;

  private canSave(): boolean {
    return this.password.length >= 8 && this.password === this.confirm && !this.busy;
  }

  private hint(): ResourceStr {
    if (this.password.length > 0 && this.password.length < 8) {
      return $r('app.string.profile_password_min_length');
    }
    if (this.confirm.length > 0 && this.password !== this.confirm) {
      return $r('app.string.auth_passwords_do_not_match');
    }
    return '';
  }

  build() {
    ProfileDialogFrame({
      colors: this.colors,
      title: $r('app.string.profile_change_password'),
      onDismiss: () => this.onDismiss(),
    }) {
      Column({ space: 14 }) {
        ProfileTextField({
          colors: this.colors,
          fieldValue: this.password,
          placeholder: $r('app.string.profile_new_password'),
          password: true,
          onValueChange: (value: string) => {
            this.password = value;
          },
        })
        ProfileTextField({
          colors: this.colors,
          fieldValue: this.confirm,
          placeholder: $r('app.string.profile_confirm_password'),
          password: true,
          onValueChange: (value: string) => {
            this.confirm = value;
          },
        })
        if (this.hint() !== '') {
          ProfileDialogHint({ colors: this.colors, text: resolveText(this.hint()) })
        }
        Row({ space: 10 }) {
          ProfileDialogButton({
            colors: this.colors,
            label: $r('app.string.common_cancel'),
            onTap: () => this.onDismiss(),
          })
          ProfileDialogButton({
            colors: this.colors,
            label: this.busy ? $r('app.string.common_saving') : $r('app.string.common_save'),
            primary: true,
            buttonEnabled: this.canSave(),
            onTap: () => {
              void this.save();
            },
          })
        }
        .width('100%')
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
    }
  }

  private async save(): Promise<void> {
    if (!this.canSave()) {
      return;
    }
    this.busy = true;
    try {
      await this.onSave(this.password);
    } finally {
      this.busy = false;
    }
  }
}

/**
 * Binds an email address.
 *
 * The dialog asks the Server whether a verification code is required before it
 * can render its second field, so the layout settles once the policy arrives; a
 * policy that fails to load offers a retry instead of a bare error.
 */
@Component
export struct EmailBindingDialog {
  colors: AAColors = AA_LIGHT_COLORS;
  currentEmail: string = '';
  /** Whether the bound address is confirmed; iOS shows it as a status row. */
  emailVerified: boolean = false;
  onDismiss: () => void = () => {};
  onLoadConfig: () => Promise<ParsedAuthConfig> = () =>
    Promise.reject(new Error('The auth config is not connected.'));
  onSendCode: (email: string) => Promise<ParsedEmailCode> = () =>
    Promise.reject(new Error('Sending a code is not connected.'));
  onSave: (email: string, code: string | null) => Promise<string> = () => Promise.resolve('');

  @State private email: string = '';
  @State private code: string = '';
  @State private config: ParsedAuthConfig | null = null;
  @State private configLoading: boolean = true;
  @State private busy: boolean = false;
  @State private cooldown: number = 0;
  @State private codeSent: boolean = false;
  @State private error: string = '';
  private cooldownTimer: number = -1;

  aboutToAppear(): void {
    this.email = this.currentEmail;
    void this.loadConfig();
  }

  aboutToDisappear(): void {
    if (this.cooldownTimer >= 0) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = -1;
    }
  }

  private async loadConfig(): Promise<void> {
    this.configLoading = true;
    this.error = '';
    try {
      this.config = await this.onLoadConfig();
    } catch (error) {
      this.error = error instanceof Error && error.message.length > 0
        ? error.message : resolveString($r('app.string.profile_update_failed'));
    } finally {
      this.configLoading = false;
    }
  }

  private validEmail(): boolean {
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(this.email.trim());
  }

  private verificationRequired(): boolean {
    return this.config !== null && this.config.emailVerificationRequired;
  }

  private canSave(): boolean {
    if (this.config === null || !this.validEmail() || this.busy) {
      return false;
    }
    return !this.verificationRequired() || this.code.length === 6;
  }

  /** Android's one-second countdown between code requests. */
  private startCooldown(seconds: number): void {
    this.cooldown = Math.max(seconds, 1);
    if (this.cooldownTimer >= 0) {
      clearTimeout(this.cooldownTimer);
    }
    this.cooldownTimer = setInterval(() => {
      if (this.cooldown <= 0) {
        if (this.cooldownTimer >= 0) {
          clearInterval(this.cooldownTimer);
          this.cooldownTimer = -1;
        }
        return;
      }
      this.cooldown -= 1;
    }, 1000);
  }

  build() {
    ProfileDialogFrame({
      colors: this.colors,
      title: $r('app.string.profile_bind_email'),
      onDismiss: () => this.onDismiss(),
    }) {
      Column({ space: 14 }) {
        ProfileTextField({
          colors: this.colors,
          fieldValue: this.email,
          placeholder: $r('app.string.profile_email'),
          onValueChange: (value: string) => {
            if (!this.busy) {
              this.email = value;
              this.code = '';
              this.codeSent = false;
              this.error = '';
            }
          },
        })

        // iOS puts the bound address's state on its own row while the field still
        // holds that address (`LabeledContent("Email status", …)`).
        if (this.currentEmail.length > 0 && this.email.trim() === this.currentEmail.trim()) {
          Row() {
            Text($r('app.string.profile_email_status'))
              .fontSize(15)
              .fontColor(this.colors.muted)
              .layoutWeight(1)

            Text(this.emailVerified
              ? $r('app.string.profile_email_verified')
              : $r('app.string.profile_email_unverified'))
              .fontSize(15)
              .fontColor(this.colors.ink)
          }
          .width('100%')
          .alignItems(VerticalAlign.Center)
        }

        if (this.configLoading) {
          Text($r('app.string.profile_loading_email_policy'))
            .fontSize(14)
            .fontColor(this.colors.muted)
        } else if (this.config === null) {
          // The button sizes itself with `layoutWeight`, which splits a row's
          // width — as a bare column child it would claim the leftover *height*,
          // which drew it as a tall outlined box, so it sits in a row of its own.
          Row() {
            ProfileDialogButton({
              colors: this.colors,
              label: $r('app.string.profile_retry'),
              onTap: () => {
                void this.loadConfig();
              },
            })
          }
          .width('100%')
        } else if (this.verificationRequired()) {
          ProfileTextField({
            colors: this.colors,
            fieldValue: this.code,
            placeholder: $r('app.string.profile_email_code'),
            onValueChange: (value: string) => {
              if (!this.busy) {
                this.code = value.replace(/[^0-9]/g, '').substring(0, 6);
              }
            },
          })
          Row() {
            ProfileDialogButton({
              colors: this.colors,
              label: this.cooldown > 0
                ? $r('app.string.profile_resend_in', this.cooldown)
                : $r('app.string.profile_send_code'),
              buttonEnabled: this.validEmail() && !this.busy && this.cooldown === 0,
              onTap: () => {
                void this.sendCode();
              },
            })
          }
          .width('100%')
          if (this.codeSent) {
            Text($r('app.string.profile_code_sent'))
              .fontSize(14)
              .fontColor(this.colors.muted)
          }
        } else {
          Text($r('app.string.profile_email_verification_disabled'))
            .fontSize(14)
            .fontColor(this.colors.muted)
        }

        if (this.error.length > 0) {
          ProfileDialogHint({ colors: this.colors, text: this.error })
        }

        Row({ space: 10 }) {
          ProfileDialogButton({
            colors: this.colors,
            label: $r('app.string.common_cancel'),
            buttonEnabled: !this.busy,
            onTap: () => this.onDismiss(),
          })
          ProfileDialogButton({
            colors: this.colors,
            label: this.busy ? $r('app.string.common_saving') : $r('app.string.common_save'),
            primary: true,
            buttonEnabled: this.canSave(),
            onTap: () => {
              void this.save();
            },
          })
        }
        .width('100%')
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
    }
  }

  private async sendCode(): Promise<void> {
    this.busy = true;
    this.error = '';
    try {
      const response: ParsedEmailCode = await this.onSendCode(this.email.trim());
      this.startCooldown(response.retryAfter);
      this.codeSent = true;
    } catch (error) {
      this.error = error instanceof Error && error.message.length > 0
        ? error.message : resolveString($r('app.string.profile_update_failed'));
    } finally {
      this.busy = false;
    }
  }

  private async save(): Promise<void> {
    if (!this.canSave()) {
      return;
    }
    this.busy = true;
    this.error = '';
    try {
      const failure: string = await this.onSave(
        this.email.trim(), this.verificationRequired() ? this.code : null,
      );
      if (failure.length > 0) {
        this.error = failure;
      }
    } finally {
      this.busy = false;
    }
  }
}

