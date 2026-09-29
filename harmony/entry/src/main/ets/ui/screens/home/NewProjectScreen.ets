import { AAColors, AA_LIGHT_COLORS } from '../../designsystem/AAColors';
import { AAIosInlineBar, AAIosPrimaryButton } from '../../designsystem/AAIosChrome';
import {
  NewSessionConfigurationCard, NewSessionConfigurationField, NewSessionConfigurationKey,
} from './NewSessionConfigurationCard';

/**
 * The project editor, shared by the home shortcut and the new-session picker.
 *
 * Port of `ui/screens/home/NewProjectScreen.kt`.
 *
 * A 58dp header with a centred title and a 40dp back button, the device field on
 * its own, a 54dp project-name field, then whatever directory browser the caller
 * hands in — Android passes that in as a `ColumnScope` slot, here it is a
 * `@BuilderParam` the caller fills with the path section. The start button at
 * the bottom doubles as the create button and is labelled accordingly while the
 * request is in flight.
 *
 * The name is a `@Prop` rather than a plain member because the parent owns it and
 * rewrites it whenever the browser lands on a directory.
 */
@Component
export struct NewProjectScreen {
  colors: AAColors = AA_LIGHT_COLORS;
  deviceField: NewSessionConfigurationField =
    new NewSessionConfigurationField(NewSessionConfigurationKey.Device, '', '', '', [], false);
  deviceMenuExpanded: boolean = false;
  onToggleDevice: () => void = () => {};
  onDismissDevice: () => void = () => {};
  onSelectDevice: (deviceId: string) => void = () => {};
  @Prop @Watch('onNameChanged') name: string = '';
  onNameChange: (value: string) => void = () => {};
  creating: boolean = false;
  canCreate: boolean = false;
  errorMessage: string = '';
  onBack: () => void = () => {};
  onCreate: () => void = () => {};
  @BuilderParam directoryContent: () => void;

  /**
   * The field's own copy, so typing is not fought by the incoming name.
   *
   * The parent still owns the value: it derives a name from the chosen directory
   * and rewrites it after a name conflict, and `@Watch` pushes those changes in.
   */
  @State private field: string = '';

  aboutToAppear(): void {
    this.field = this.name;
  }

  onNameChanged(): void {
    if (this.field !== this.name) {
      this.field = this.name;
    }
  }

  build() {
    Column() {
      // iOS's `ProjectEditorSheet`: an inline navigation bar (创建项目 / 编辑项目),
      // a Form of sections, and the create action as the prominent capsule.
      AAIosInlineBar({
        colors: this.colors,
        title: $r('app.string.new_session_create_project'),
        onBack: () => this.onBack(),
      })

      Column({ space: 28 }) {
        NewSessionConfigurationCard({
          colors: this.colors,
          fields: [this.deviceField],
          expandedKey: this.deviceMenuExpanded ? NewSessionConfigurationKey.Device : -1,
          onToggle: () => this.onToggleDevice(),
          onDismiss: () => this.onDismissDevice(),
          onSelect: (key: NewSessionConfigurationKey, optionId: string) => {
            this.onSelectDevice(optionId);
          },
        })

        Column({ space: 7 }) {
          // iOS's Form section caption above a borderless card.
          Text($r('app.string.new_session_project_name'))
            .fontSize(13)
            .fontWeight(FontWeight.Medium)
            .fontColor(this.colors.muted)
            .textCase(TextCase.UpperCase)
            .width('100%')
            .padding({ left: 16 })

          Stack({ alignContent: Alignment.Bottom }) {
            TextInput({ text: this.field, placeholder: $r('app.string.new_session_project_name_placeholder') })
              .width('100%')
              .height(54)
              .padding({ left: 16, right: 16, top: 16, bottom: 16 })
              .borderRadius(0)
              .backgroundColor('#00000000')
              .fontSize(17)
              .fontColor(this.colors.ink)
              .placeholderColor(this.colors.faint)
              .caretColor(this.colors.ink)
              .enabled(!this.creating)
              .enterKeyType(EnterKeyType.Done)
              .onChange((value: string) => {
                this.field = value;
                this.onNameChange(value);
              })

            Divider().color(this.colors.border).margin({ left: 16, right: 16 })
          }
          .width('100%')
          .borderRadius(12)
          .backgroundColor(this.colors.raisedSurface)
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)

        this.directoryContent()
      }
      .width('100%')
      .layoutWeight(1)
      .padding({ left: 22, right: 22, top: 12 })
      .alignItems(HorizontalAlign.Start)

      Column({ space: 10 }) {
        if (this.errorMessage.length > 0) {
          Text(this.errorMessage)
            .fontSize(13)
            .lineHeight(17)
            .fontColor(this.colors.errorText)
            .width('100%')
        }

        AAIosPrimaryButton({
          colors: this.colors,
          label: this.creating
            ? $r('app.string.new_session_project_creating')
            : $r('app.string.new_session_create_project'),
          loading: this.creating,
          buttonEnabled: this.canCreate,
          onTap: () => this.onCreate(),
        })
      }
      .width('100%')
      .padding({ left: 22, right: 22, top: 10, bottom: 12 })
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .height('100%')
    .backgroundColor(this.colors.canvas)
    .alignItems(HorizontalAlign.Start)
    .onClick(() => {
      // Android clears focus and hides the keyboard on any tap outside a field.
      this.getUIContext().getFocusController().clearFocus();
    })
  }
}
