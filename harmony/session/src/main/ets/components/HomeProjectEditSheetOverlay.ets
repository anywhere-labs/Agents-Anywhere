import { APP_IS_DARK_KEY, getColors } from 'common';

@Component
export struct HomeProjectEditSheetOverlay {
  @StorageProp(APP_IS_DARK_KEY) themeIsDark: boolean = false;
  @Prop originalName: string = '';
  @Prop deviceName: string = '';
  @Prop workspacePath: string = '';
  @Prop nameInput: string = '';
  @Prop busy: boolean = false;
  @Prop errorMessage: string = '';
  onNameChange: (name: string) => void = () => {};
  onSave: () => void = () => {};
  onDismiss: () => void = () => {};

  private fieldBackground(): string {
    return this.themeIsDark ? '#111113' : '#F7F7F5';
  }

  private handleColor(): string {
    return this.themeIsDark ? '#3F3F46' : '#D8D6D0';
  }

  private canSave(): boolean {
    const trimmed = this.nameInput.trim();
    return !this.busy && trimmed.length > 0 && trimmed !== this.originalName;
  }

  @Builder
  fieldLabel(label: ResourceStr) {
    Text(label)
      .fontSize(13)
      .fontWeight(FontWeight.Bold)
      .fontColor(getColors().inkSoft)
      .width('100%')
  }

  @Builder
  readOnlyField(value: string, monospace: boolean) {
    Row() {
      Text(value)
        .fontSize(monospace ? 13 : 15)
        .fontFamily(monospace ? 'monospace' : '')
        .fontColor(getColors().faint)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
    }
    .width('100%')
    .height(50)
    .padding({ left: 14, right: 14 })
    .alignItems(VerticalAlign.Center)
    .borderRadius(12)
    .backgroundColor(this.fieldBackground())
    .border({ width: 1, color: getColors().border })
  }

  @Builder
  sheetButton(label: ResourceStr, enabled: boolean, primary: boolean, action: () => void) {
    Row() {
      Text(label)
        .fontSize(15)
        .fontWeight(FontWeight.Bold)
        .fontColor(primary ? getColors().onPrimaryAction : getColors().ink)
    }
    .layoutWeight(1)
    .height(50)
    .justifyContent(FlexAlign.Center)
    .borderRadius(16)
    .backgroundColor(primary ? getColors().primaryAction : getColors().secondaryActionSurface)
    .opacity(enabled ? 1 : 0.38)
    .onClick(() => {
      if (enabled) {
        action();
      }
    })
  }

  build() {
    Stack() {
      Column()
        .width('100%')
        .height('100%')
        .backgroundColor(this.themeIsDark ? '#99000000' : '#66000000')
        .onClick(() => {
          if (!this.busy) {
            this.onDismiss();
          }
        })
      Column({ space: 14 }) {
        Stack() {
          Column()
            .width(40)
            .height(4)
            .borderRadius(2)
            .backgroundColor(this.handleColor())
        }
        .width('100%')
        .height(12)
        .alignContent(Alignment.Center)
        Text($r('app.string.home_project_edit_title'))
          .fontSize(22)
          .fontWeight(800)
          .fontColor(getColors().ink)
          .width('100%')
        this.fieldLabel($r('app.string.home_project_name'))
        TextInput({ text: this.nameInput })
          .height(50)
          .borderRadius(12)
          .backgroundColor(this.fieldBackground())
          .border({ width: 1, color: getColors().border })
          .padding({ left: 14, right: 14 })
          .fontSize(16)
          .fontWeight(FontWeight.Bold)
          .fontColor(getColors().ink)
          .caretColor(getColors().ink)
          .maxLength(255)
          .enabled(!this.busy)
          .onChange((value: string) => {
            this.onNameChange(value);
          })
        this.fieldLabel($r('app.string.home_project_device'))
        this.readOnlyField(this.deviceName, false)
        this.fieldLabel($r('app.string.home_project_path'))
        this.readOnlyField(this.workspacePath, true)
        Text($r('app.string.home_project_path_immutable'))
          .fontSize(12.5)
          .lineHeight(17)
          .fontColor(getColors().faint)
          .width('100%')
        if (this.errorMessage.length > 0) {
          Text(this.errorMessage)
            .fontSize(13)
            .fontWeight(600)
            .fontColor(getColors().errorText)
            .width('100%')
        }
        Row({ space: 10 }) {
          this.sheetButton($r('app.string.common_cancel'), !this.busy, false, (): void => {
            this.onDismiss();
          })
          this.sheetButton(this.busy ? $r('app.string.common_saving') : $r('app.string.common_save'),
            this.canSave(), true, (): void => {
              this.onSave();
            })
        }
        .width('100%')
        .margin({ top: 6 })
      }
      .width('100%')
      .padding({ left: 22, right: 22, top: 12, bottom: 34 })
      .borderRadius({ topLeft: 28, topRight: 28 })
      .backgroundColor(getColors().raisedSurface)
    }
    .width('100%')
    .height('100%')
    .alignContent(Alignment.Bottom)
  }
}
