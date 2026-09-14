import { AAColors, AA_LIGHT_COLORS } from '../../designsystem/AAColors';
import { AADropdownMenu, AADropdownMenuItemSpec } from '../../designsystem/AADropdownMenu';
import { AAIcon } from '../../designsystem/AAIcon';
import { AA_ICONS } from '../../designsystem/AAIcons';
import { ParsedAuthConfig, ParsedAuthMe, ParsedEmailCode } from '../../../api/AuthDtos';
import { AppConfig } from '../../../config/AppConfig';
import { AAToastHost, AAToastState } from '../../designsystem/AAToast';
import { ProfileAccountPage } from './ProfileAccountPage';
import { AppUpdateDetailPage } from '../update/AppUpdateDetailPage';
import { AppUpdateState } from '../../../feature/update/AppUpdateController';
import {
  ChangePasswordDialog, EmailBindingDialog, NicknameDialog,
} from './ProfileDialogs';
import {
  AALanguageMode, AAAppearanceMode, accountLabel, labelForAppearance, labelForLanguage,
  labelForSidebarView, profilePageBackground,
} from './ProfileSettingsSupport';
import {
  ProfileDivider, ProfileHeader, ProfileRow, SettingsGroup, SignOutCard,
} from './ProfileSettingsComponents';
import { resolveString, resolveText } from '../../../common/AAResources';

/**
 * The settings drawer.
 *
 * Port of `ui/screens/profile/ProfileSettingsDrawer.kt`.
 *
 * Android slides this page in from the left over whatever screen is showing and
 * keeps its own detail pages (Account, Language, Updates) inside it. This port
 * renders the same full-screen page as an overlay of the app shell; this round
 * covers the index page and the Language detail page. The Account page and its
 * four identity dialogs, and the Updates page, are the next pass and are listed
 * in the plan — which is also why the "check for updates" row is inert.
 *
 * The four surfaces come from `ProfileSettingsSupport`: a warmer canvas on light,
 * pure white cards and a 0.8dp card border, because the settings page is the one
 * place the app deliberately leaves the shared token palette.
 *
 * ArkUI has no plain component slot, so Android's `ProfileCard` wrapper is
 * written out at each use rather than passed in as content.
 */

/** The drawer's own pages; Android's `ProfileDetailPage`. */
enum ProfileDetailPage {
  None = 0,
  Account = 1,
  Language = 2,
  Updates = 3,
}

@Component
export struct ProfileSettingsDrawer {
  colors: AAColors = AA_LIGHT_COLORS;
  userId: string = '';
  role: string = '';
  serverUrl: string = '';
  appearanceMode: string = AAAppearanceMode.SYSTEM;
  languageMode: string = AALanguageMode.SYSTEM;
  sidebarViewMode: string = 'project';
  appVersion: string = AppConfig.CLIENT_VERSION_NAME;
  onAppearanceModeChange: (mode: string) => void = () => {};
  onLanguageModeChange: (mode: string) => void = () => {};
  onSidebarViewModeChange: (mode: string) => void = () => {};
  onOpenArchivedSessions: () => void = () => {};
  /** The update check's state, shown by the version card and the Updates page. */
  appUpdate: AppUpdateState = AppUpdateState.empty();
  /** Android's `showUpdatePrompt`: opens the prompt, or checks first. */
  onUpdateNow: () => void = () => {};
  onCheckForUpdates: () => void = () => {};
  onSignOut: () => void = () => {};
  onClose: () => void = () => {};
  /** Loads the signed-in account; a failure is shown as the page's toast. */
  onLoadAccount: () => Promise<ParsedAuthMe> = () =>
    Promise.reject(new Error('The account endpoint is not connected.'));
  onUpdateDisplayName: (displayName: string) => Promise<ParsedAuthMe> = () =>
    Promise.reject(new Error('Renaming is not connected.'));
  onChangePassword: (password: string) => Promise<void> = () =>
    Promise.reject(new Error('Changing the password is not connected.'));
  onLoadAuthConfig: () => Promise<ParsedAuthConfig> = () =>
    Promise.reject(new Error('The auth policy is not connected.'));
  onSendEmailCode: (email: string) => Promise<ParsedEmailCode> = () =>
    Promise.reject(new Error('Sending a code is not connected.'));
  onBindEmail: (email: string, code: string | null) => Promise<ParsedAuthMe> = () =>
    Promise.reject(new Error('Binding an email is not connected.'));
  /** Opens the image picker and returns the chosen picture as a data URL. */
  onPickAvatar: () => Promise<string | null> = () => Promise.resolve(null);
  onUpdateAvatar: (dataUrl: string) => Promise<ParsedAuthMe> = () =>
    Promise.reject(new Error('Updating the avatar is not connected.'));

  @State private account: ParsedAuthMe | null = null;
  @State private detailPage: ProfileDetailPage = ProfileDetailPage.None;
  @State private appearanceMenuOpen: boolean = false;
  @State private sidebarMenuOpen: boolean = false;
  @State private signOutOpen: boolean = false;
  @State private nicknameOpen: boolean = false;
  @State private emailOpen: boolean = false;
  @State private passwordOpen: boolean = false;
  @State private avatarBusy: boolean = false;
  /** Android's `showError`: a fixed-timeout toast inside the drawer. */
  private toast: AAToastState = new AAToastState();

  aboutToAppear(): void {
    void this.loadAccount();
  }

  aboutToDisappear(): void {
    this.toast.hide();
  }

  /** Android reloads the account every time the drawer opens. */
  private async loadAccount(): Promise<void> {
    try {
      this.account = await this.onLoadAccount();
    } catch (error) {
      this.toast.show(error instanceof Error && error.message.length > 0
        ? error.message : $r('app.string.profile_account_load_failed'), true);
    }
  }

  private accountName(): string {
    const account: ParsedAuthMe | null = this.account;
    if (account === null) {
      return this.userId;
    }
    const label: string = accountLabel(account);
    return label.length > 0 ? label : resolveString($r('app.string.profile_account_fallback'));
  }

  /** The avatar as an image source, or an empty string when there is none. */
  private avatarSource(): string {
    const account: ParsedAuthMe | null = this.account;
    if (account === null || account.avatar === null) {
      return '';
    }
    return account.avatar;
  }

  /** The bound email, or an empty string when the account has none yet. */
  private emailText(): string {
    const account: ParsedAuthMe | null = this.account;
    if (account === null || account.email === null) {
      return '';
    }
    return account.email;
  }

  private serviceLabel(): ResourceStr {
    return AppConfig.isOfficialServer(this.serverUrl)
      ? $r('app.string.profile_official_service')
      : $r('app.string.profile_self_hosted');
  }

  private detailTitle(): ResourceStr {
    if (this.detailPage === ProfileDetailPage.Language) {
      return $r('app.string.profile_language');
    }
    if (this.detailPage === ProfileDetailPage.Updates) {
      return $r('app.string.profile_updates');
    }
    if (this.detailPage === ProfileDetailPage.Account) {
      return $r('app.string.profile_account');
    }
    return $r('app.string.profile_settings');
  }

  build() {
    Stack({ alignContent: Alignment.Bottom }) {
      Column() {
        if (this.detailPage !== ProfileDetailPage.None) {
          this.DetailContent()
        } else {
          this.IndexContent()
        }
      }
      .width('100%')
      .height('100%')
      .backgroundColor(profilePageBackground(this.colors))
      .padding({ left: 18, right: 18 })

      AAToastHost({
        colors: this.colors,
        message: this.toast.message,
        isError: this.toast.isError,
        actionLabel: this.toast.actionLabel,
        visible: this.toast.visible,
        onAction: () => this.toast.hide(),
      })

      if (this.signOutOpen) {
        this.SignOutDialog()
      }

      if (this.nicknameOpen) {
        NicknameDialog({
          colors: this.colors,
          displayName: this.account === null ? '' : (this.account as ParsedAuthMe).displayName,
          onDismiss: () => {
            this.nicknameOpen = false;
          },
          onSave: async (displayName: string) => await this.saveDisplayName(displayName),
        })
      }

      if (this.passwordOpen) {
        ChangePasswordDialog({
          colors: this.colors,
          onDismiss: () => {
            this.passwordOpen = false;
          },
          onSave: async (password: string) => await this.savePassword(password),
        })
      }

      if (this.emailOpen) {
        EmailBindingDialog({
          colors: this.colors,
          currentEmail: this.account === null
            ? '' : ((this.account as ParsedAuthMe).email ?? ''),
          onDismiss: () => {
            this.emailOpen = false;
          },
          onLoadConfig: () => this.onLoadAuthConfig(),
          onSendCode: (email: string) => this.onSendEmailCode(email),
          onSave: async (email: string, code: string | null) => await this.saveEmail(email, code),
        })
      }
    }
    .width('100%')
    .height('100%')
  }

  /** Renaming reports its failure as a message, which the dialog shows inline. */
  private async saveDisplayName(displayName: string): Promise<string> {
    try {
      this.account = await this.onUpdateDisplayName(displayName);
      this.nicknameOpen = false;
      this.toast.show($r('app.string.profile_updated'), false);
      return '';
    } catch (error) {
      return error instanceof Error && error.message.length > 0
        ? error.message : resolveString($r('app.string.profile_update_failed'));
    }
  }

  private async savePassword(password: string): Promise<string> {
    try {
      await this.onChangePassword(password);
      this.passwordOpen = false;
      this.toast.show($r('app.string.profile_password_updated'), false);
      return '';
    } catch (error) {
      return error instanceof Error && error.message.length > 0
        ? error.message : resolveString($r('app.string.profile_password_update_failed'));
    }
  }

  private async saveEmail(email: string, code: string | null): Promise<string> {
    try {
      this.account = await this.onBindEmail(email, code);
      this.emailOpen = false;
      this.toast.show($r('app.string.profile_updated'), false);
      return '';
    } catch (error) {
      return error instanceof Error && error.message.length > 0
        ? error.message : resolveString($r('app.string.profile_update_failed'));
    }
  }

  /**
   * Picks a picture and sends it as a data URL.
   *
   * Android scales it to 256px before sending; `onPickAvatar` does that work, so
   * this only has to report the two failure kinds — nothing picked, and the
   * upload rejected.
   */
  private async pickAvatar(): Promise<void> {
    if (this.avatarBusy) {
      return;
    }
    this.avatarBusy = true;
    try {
      const dataUrl: string | null = await this.onPickAvatar();
      if (dataUrl === null) {
        return;
      }
      this.account = await this.onUpdateAvatar(dataUrl);
      this.toast.show($r('app.string.profile_avatar_updated'), false);
    } catch (error) {
      this.toast.show(error instanceof Error && error.message.length > 0
        ? error.message : $r('app.string.profile_avatar_update_failed'), true);
    } finally {
      this.avatarBusy = false;
    }
  }

  /**
   * The sign-out confirmation.
   *
   * Port of `ProfileSettingsDialogs.kt`'s `ConfirmSignOutDialog`, drawn with the
   * same chrome as the device dialogs: a 26dp card capped at 380dp, 22dp padding,
   * a 24sp/29sp extra-bold title and a 50dp/16dp button pair.
   */
  @Builder
  SignOutDialog() {
    Column() {
      Column({ space: 18 }) {
        Text($r('app.string.profile_sign_out_title'))
          .fontSize(24)
          .lineHeight(29)
          .fontWeight(800)
          .fontColor(this.colors.ink)
          .width('100%')

        Text($r('app.string.profile_sign_out_body'))
          .fontSize(15)
          .lineHeight(21)
          .fontWeight(FontWeight.Medium)
          .fontColor(this.colors.inkSoft)
          .width('100%')

        Row({ space: 12 }) {
          this.DialogButton($r('app.string.common_cancel'), false)
          this.DialogButton($r('app.string.profile_sign_out'), true)
        }
        .width('100%')
      }
      .constraintSize({ maxWidth: 380 })
      .width('100%')
      .padding(22)
      .borderRadius(26)
      .backgroundColor(this.colors.dialogSurface)
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .height('100%')
    .padding({ left: 24, right: 24 })
    .backgroundColor(this.colors.isDark ? '#8F000000' : '#47000000')
    .justifyContent(FlexAlign.Center)
    .onClick(() => {
      this.signOutOpen = false;
    })
  }

  @Builder
  DialogButton(label: ResourceStr, danger: boolean) {
    Text(label)
      .fontSize(15)
      .lineHeight(19)
      .fontWeight(FontWeight.Bold)
      .fontColor(danger ? '#FFFFFF' : this.colors.ink)
      .textAlign(TextAlign.Center)
      .layoutWeight(1)
      .height(50)
      .borderRadius(16)
      .backgroundColor(danger ? '#EF4444' : this.colors.subtle)
      .border({ width: danger ? 0 : 1, color: this.colors.border })
      .onClick(() => {
        this.signOutOpen = false;
        if (danger) {
          this.onSignOut();
        }
      })
  }

  @Builder
  IndexContent() {
    // iOS's `AccountSettingsSheet`: one inset-grouped list, section captions above
    // borderless cards, the identity as a plain header row, and the version in the
    // footer instead of a row of its own.
    List({ space: 28 }) {
      ListItem() {
        this.IdentityHeader()
      }

      ListItem() {
        SettingsGroup({ colors: this.colors, title: $r('app.string.profile_account') }) {
          ProfileRow({
            colors: this.colors,
            commands: AA_ICONS.PENCIL,
            title: $r('app.string.profile_nickname'),
            trailing: this.account === null ? '' : this.account.displayName,
            onTap: () => {
              this.nicknameOpen = true;
            },
          })
          ProfileDivider({ colors: this.colors })
          ProfileRow({
            colors: this.colors,
            commands: AA_ICONS.ENVELOPE,
            title: $r('app.string.profile_email'),
            trailing: this.emailText(),
            onTap: () => {
              this.emailOpen = true;
            },
          })
          ProfileDivider({ colors: this.colors })
          ProfileRow({
            colors: this.colors,
            commands: AA_ICONS.USER_ROUND,
            title: $r('app.string.profile_avatar_change'),
            showChevron: false,
            onTap: () => {
              void this.pickAvatar();
            },
          })
          ProfileDivider({ colors: this.colors })
          ProfileRow({
            colors: this.colors,
            commands: AA_ICONS.KEY_ROUND,
            title: $r('app.string.profile_change_password'),
            showChevron: false,
            onTap: () => {
              this.passwordOpen = true;
            },
          })
        }
      }

      ListItem() {
        SettingsGroup({ colors: this.colors, title: $r('app.string.settings_section_app') }) {
          ProfileRow({
            colors: this.colors,
            commands: AA_ICONS.MOON,
            title: $r('app.string.profile_appearance'),
            trailing: resolveText(labelForAppearance(this.appearanceMode)),
            // The two popup rows keep the up-down chevrons that mark a picker.
            trailingIcon: AA_ICONS.CHEVRONS_UP_DOWN,
            showChevron: false,
            onTap: () => {
              this.appearanceMenuOpen = true;
            },
          })
            .bindMenu(this.appearanceMenuOpen, this.AppearanceMenu(), {
              placement: Placement.BottomRight,
              enableArrow: false,
              onDisappear: () => {
                this.appearanceMenuOpen = false;
              },
            })
          ProfileDivider({ colors: this.colors })
          ProfileRow({
            colors: this.colors,
            commands: AA_ICONS.GLOBE,
            title: $r('app.string.profile_language'),
            trailing: resolveText(labelForLanguage(this.languageMode)),
            onTap: () => {
              this.detailPage = ProfileDetailPage.Language;
            },
          })
          ProfileDivider({ colors: this.colors })
          ProfileRow({
            colors: this.colors,
            commands: AA_ICONS.LIST,
            title: $r('app.string.profile_sidebar_display'),
            trailing: resolveText(labelForSidebarView(this.sidebarViewMode)),
            trailingIcon: AA_ICONS.CHEVRONS_UP_DOWN,
            showChevron: false,
            onTap: () => {
              this.sidebarMenuOpen = true;
            },
          })
            .bindMenu(this.sidebarMenuOpen, this.SidebarMenu(), {
              placement: Placement.BottomRight,
              enableArrow: false,
              onDisappear: () => {
                this.sidebarMenuOpen = false;
              },
            })
        }
      }

      ListItem() {
        SettingsGroup({ colors: this.colors }) {
          ProfileRow({
            colors: this.colors,
            commands: AA_ICONS.ARCHIVE,
            title: $r('app.string.profile_archived_sessions'),
            onTap: () => this.onOpenArchivedSessions(),
          })
          ProfileDivider({ colors: this.colors })
          // Android's row opens the Updates page, or the prompt when a release is
          // already known; the download step is "open the download page" here.
          ProfileRow({
            colors: this.colors,
            commands: AA_ICONS.SERVER,
            title: $r('app.string.profile_check_updates'),
            trailingIcon: this.appUpdate.release !== null ? AA_ICONS.DOWNLOAD : '',
            trailingAttention: this.appUpdate.release !== null,
            showChevron: this.appUpdate.release === null,
            onTap: () => {
              if (this.appUpdate.release !== null) {
                this.onUpdateNow();
              } else {
                this.detailPage = ProfileDetailPage.Updates;
                this.onCheckForUpdates();
              }
            },
          })
        }
      }

      ListItem() {
        Column({ space: 16 }) {
          SettingsGroup({ colors: this.colors }) {
            SignOutCard({
              colors: this.colors,
              label: $r('app.string.profile_sign_out'),
              onTap: () => {
                this.signOutOpen = true;
              },
            })
          }

          // iOS's list footer: the app name and the version, centred.
          Text(`Agents Anywhere · v${this.appVersion}`)
            .fontSize(13)
            .fontColor(this.colors.muted)
            .textAlign(TextAlign.Center)
            .width('100%')
        }
        .width('100%')
      }

      ListItem() {
        Column().height(28)
      }
    }
    .width('100%')
    .layoutWeight(1)
    .scrollBar(BarState.Off)
  }

  @Builder
  DetailContent() {
    List({ space: 28 }) {
      ListItem() {
        ProfileHeader({
          colors: this.colors,
          title: this.detailTitle(),
          onClose: () => {
            this.detailPage = ProfileDetailPage.None;
          },
        })
      }

      if (this.detailPage === ProfileDetailPage.Language) {
        ListItem() {
          // iOS's `SettingsLanguageView` is a plain section: no caption, since the
          // navigation bar already carries the page title.
          SettingsGroup({ colors: this.colors }) {
            this.LanguageRow($r('app.string.profile_language_follow_system'), AALanguageMode.SYSTEM)
            ProfileDivider({ colors: this.colors })
            this.LanguageRow($r('app.string.profile_english'), AALanguageMode.ENGLISH)
            ProfileDivider({ colors: this.colors })
            this.LanguageRow(
              $r('app.string.profile_simplified_chinese'), AALanguageMode.SIMPLIFIED_CHINESE,
            )
          }
        }
      } else if (this.detailPage === ProfileDetailPage.Updates) {
        ListItem() {
          AppUpdateDetailPage({
            colors: this.colors,
            state: this.appUpdate,
            onUpdate: () => this.onUpdateNow(),
            onCheckAgain: () => this.onCheckForUpdates(),
          })
        }
      } else {
        ListItem() {
          ProfileAccountPage({
            colors: this.colors,
            account: this.account,
            avatarBusy: this.avatarBusy,
            onChangeAvatar: () => {
              void this.pickAvatar();
            },
            onChangeNickname: () => {
              this.nicknameOpen = true;
            },
            onChangeEmail: () => {
              this.emailOpen = true;
            },
            onChangePassword: () => {
              this.passwordOpen = true;
            },
            onSignOut: () => {
              this.signOutOpen = true;
            },
          })
        }
      }

      ListItem() {
        Column().height(28)
      }
    }
    .width('100%')
    .layoutWeight(1)
    .scrollBar(BarState.Off)
  }

  /** One language choice: an iOS list row with a trailing check when selected. */
  @Builder
  LanguageRow(title: ResourceStr, mode: string) {
    Row() {
      Text(title)
        .fontSize(17)
        .lineHeight(21)
        .fontColor(this.colors.ink)
        .maxLines(1)
        .layoutWeight(1)

      if (this.languageMode === mode) {
        AAIcon({ commands: AA_ICONS.CHECK, iconSize: 17, color: this.colors.ink })
      }
    }
    .width('100%')
    .height(48)
    .padding({ left: 16, right: 16 })
    .alignItems(VerticalAlign.Center)
    .onClick(() => {
      this.onLanguageModeChange(mode);
    })
  }

  /**
   * The identity header.
   *
   * iOS's `AccountSettingsSheet` opens with a list row that has no card behind
   * it: a 60pt avatar, the account label at `title3` semibold, the email at
   * `subheadline` and the role at `caption`, all in the secondary colour after
   * the label. Tapping it still opens the account page, as Android's card did.
   */
  @Builder
  IdentityHeader() {
    Row({ space: 16 }) {
      Column() {
        if (this.avatarSource().length > 0) {
          Image(this.avatarSource())
            .width(60)
            .height(60)
            .borderRadius(30)
            .objectFit(ImageFit.Cover)
        } else {
          Text(this.accountName().length > 0 ? this.accountName().charAt(0).toUpperCase() : '?')
            .fontSize(24)
            .fontWeight(600)
            .fontColor(this.colors.ink)
        }
      }
      .width(60)
      .height(60)
      .borderRadius(30)
      .backgroundColor(this.colors.subtle)
      .justifyContent(FlexAlign.Center)

      Column({ space: 5 }) {
        Text(this.accountName())
          .fontSize(20)
          .lineHeight(25)
          .fontWeight(600)
          .fontColor(this.colors.ink)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')

        if (this.emailText().length > 0) {
          Text(this.emailText())
            .fontSize(15)
            .lineHeight(19)
            .fontColor(this.colors.muted)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')
        }

        Text(this.serviceLabel())
          .fontSize(12)
          .lineHeight(16)
          .fontColor(this.colors.muted)
          .maxLines(1)
          .width('100%')
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .padding({ left: 16, right: 16, top: 12, bottom: 12 })
    .alignItems(VerticalAlign.Center)
    .onClick(() => {
      this.detailPage = ProfileDetailPage.Account;
    })
  }

  @Builder
  AppearanceMenu() {
    AADropdownMenu({
      colors: this.colors,
      items: this.appearanceItems(),
      selectedId: this.appearanceMode,
      onSelect: (mode: string) => this.onAppearanceModeChange(mode),
      onDismiss: () => {
        this.appearanceMenuOpen = false;
      },
    })
  }

  @Builder
  SidebarMenu() {
    AADropdownMenu({
      colors: this.colors,
      items: this.sidebarItems(),
      selectedId: this.sidebarViewMode,
      onSelect: (mode: string) => this.onSidebarViewModeChange(mode),
      onDismiss: () => {
        this.sidebarMenuOpen = false;
      },
    })
  }

  private appearanceItems(): AADropdownMenuItemSpec[] {
    return [
      new AADropdownMenuItemSpec(
        AAAppearanceMode.SYSTEM, resolveString($r('app.string.profile_follow_system')),
      ),
      new AADropdownMenuItemSpec(AAAppearanceMode.LIGHT, resolveString($r('app.string.profile_light'))),
      new AADropdownMenuItemSpec(AAAppearanceMode.DARK, resolveString($r('app.string.profile_dark'))),
    ];
  }

  private sidebarItems(): AADropdownMenuItemSpec[] {
    return [
      new AADropdownMenuItemSpec('project', resolveString($r('app.string.profile_project_view'))),
      new AADropdownMenuItemSpec('session', resolveString($r('app.string.profile_session_view'))),
    ];
  }
}
