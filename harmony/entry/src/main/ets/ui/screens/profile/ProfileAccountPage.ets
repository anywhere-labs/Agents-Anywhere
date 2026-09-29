import { AAColors, AA_LIGHT_COLORS, withAlpha } from '../../designsystem/AAColors';
import { AA_ICONS } from '../../designsystem/AAIcons';
import { ParsedAuthMe } from '../../../api/AuthDtos';
import { accountLabel, prettyRole } from './ProfileSettingsSupport';
import { ProfileDivider, ProfileRow, SettingsGroup, SignOutCard } from './ProfileSettingsComponents';
import { resolveString } from '../../../common/AAResources';

/**
 * The account page.
 *
 * Port of `ProfileSettingsDetails.kt`'s `AccountDetailPage`, restyled in round 40
 * to the iOS list language (`Views/Settings/AccountSettingsSheet.swift`): the
 * identity as a plain header row, then inset-grouped sections — the account
 * values as `LabeledContent` rows, the edit actions as symbol rows and the sign
 * out as iOS's destructive row. Navigation, callbacks and copy are unchanged.
 */

/**
 * The avatar: the picture when there is one, otherwise the label's first letter
 * on the brand violet, with a translucent veil while the account is disabled.
 */
@Component
export struct ProfileAvatar {
  colors: AAColors = AA_LIGHT_COLORS;
  account: ParsedAuthMe | null = null;
  avatarSize: number = 86;

  private letter(): string {
    const account: ParsedAuthMe | null = this.account;
    if (account === null) {
      return 'A';
    }
    const label: string = accountLabel(account).trim();
    return label.length > 0 ? label.charAt(0).toUpperCase() : 'A';
  }

  private avatarSource(): string {
    const account: ParsedAuthMe | null = this.account;
    if (account === null || account.avatar === null) {
      return '';
    }
    return account.avatar;
  }

  private disabled(): boolean {
    return this.account !== null && this.account.disabled;
  }

  build() {
    Stack() {
      if (this.avatarSource().length > 0) {
        Image(this.avatarSource())
          .width(this.avatarSize)
          .height(this.avatarSize)
          .objectFit(ImageFit.Cover)
      } else {
        Text(this.letter())
          .fontSize(this.avatarSize * 0.52)
          .fontWeight(FontWeight.Medium)
          .fontColor('#FFFFFF')
      }

      if (this.disabled()) {
        Column()
          .width(this.avatarSize)
          .height(this.avatarSize)
          .backgroundColor(withAlpha(this.colors.canvas, 0.55))
      }
    }
    .width(this.avatarSize)
    .height(this.avatarSize)
    .borderRadius(this.avatarSize / 2)
    .backgroundColor('#7857D8')
    .clip(true)
  }
}

@Component
export struct ProfileAccountPage {
  colors: AAColors = AA_LIGHT_COLORS;
  account: ParsedAuthMe | null = null;
  avatarBusy: boolean = false;
  onChangeAvatar: () => void = () => {};
  onChangeNickname: () => void = () => {};
  onChangeEmail: () => void = () => {};
  onChangePassword: () => void = () => {};
  onSignOut: () => void = () => {};

  private displayName(): string {
    const account: ParsedAuthMe | null = this.account;
    if (account === null || account.displayName.trim().length === 0) {
      return resolveString($r('app.string.profile_account_fallback'));
    }
    return account.displayName;
  }

  private email(): string {
    const account: ParsedAuthMe | null = this.account;
    if (account === null || account.email === null) {
      return resolveString($r('app.string.profile_email_unbound'));
    }
    return account.email;
  }

  private role(): string {
    const account: ParsedAuthMe | null = this.account;
    if (account === null || account.role.trim().length === 0) {
      return prettyRole('member');
    }
    return prettyRole(account.role);
  }

  build() {
    Column({ space: 28 }) {
      // The identity header, as the drawer's: a 60dp avatar with the label, the
      // email and the role beside it, on the page background rather than a card.
      Row({ space: 16 }) {
        ProfileAvatar({
          colors: this.colors,
          account: this.account,
          avatarSize: 60,
        })

        Column({ space: 5 }) {
          Text(this.displayName())
            .fontSize(20)
            .lineHeight(25)
            .fontWeight(600)
            .fontColor(this.colors.ink)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')

          Text(this.email())
            .fontSize(15)
            .lineHeight(19)
            .fontColor(this.colors.muted)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')

          Text(this.role())
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
        if (!this.avatarBusy) {
          this.onChangeAvatar();
        }
      })

      SettingsGroup({ colors: this.colors, title: $r('app.string.profile_account') }) {
        ProfileRow({
          colors: this.colors,
          commands: '',
          title: $r('app.string.profile_nickname'),
          trailing: this.displayName(),
          showChevron: false,
        })
        ProfileDivider({ colors: this.colors })
        ProfileRow({
          colors: this.colors,
          commands: '',
          title: $r('app.string.profile_email'),
          trailing: this.email(),
          showChevron: false,
        })
        ProfileDivider({ colors: this.colors })
        ProfileRow({
          colors: this.colors,
          commands: '',
          title: $r('app.string.profile_role'),
          trailing: this.role(),
          showChevron: false,
        })
      }

      SettingsGroup({ colors: this.colors }) {
        ProfileRow({
          colors: this.colors,
          commands: AA_ICONS.PENCIL,
          title: $r('app.string.profile_edit_nickname'),
          showChevron: false,
          onTap: () => this.onChangeNickname(),
        })
        ProfileDivider({ colors: this.colors })
        ProfileRow({
          colors: this.colors,
          commands: AA_ICONS.ENVELOPE,
          title: $r('app.string.profile_bind_email'),
          showChevron: false,
          onTap: () => this.onChangeEmail(),
        })
        ProfileDivider({ colors: this.colors })
        ProfileRow({
          colors: this.colors,
          commands: AA_ICONS.KEY_ROUND,
          title: $r('app.string.profile_change_password'),
          showChevron: false,
          onTap: () => this.onChangePassword(),
        })
      }

      SettingsGroup({ colors: this.colors }) {
        SignOutCard({
          colors: this.colors,
          label: $r('app.string.profile_sign_out'),
          onTap: () => this.onSignOut(),
        })
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .padding({ bottom: 28 })
  }
}
