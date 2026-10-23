import { APP_IS_DARK_KEY, getColors } from 'common';

@Component
export struct StringInputDialog {
  @StorageProp(APP_IS_DARK_KEY) themeIsDark: boolean = false;
  title: ResourceStr = '';
  initial: string = '';
  placeholder: ResourceStr = '';
  saveLabel: ResourceStr = $r('app.string.profile_save');
  busy: boolean = false;
  onSave: (value: string) => void = () => {};
  onCancel: () => void = () => {};
  @State text: string = '';

  aboutToAppear(): void {
    this.text = this.initial;
  }

  build() {
    Stack() {
      Column() {
      }
      .width('100%')
      .height('100%')
      .backgroundColor('rgba(0,0,0,0.45)')
      .onClick(() => {
        this.onCancel();
      })
      Column({ space: 14 }) {
        Text(this.title)
          .fontSize(17)
          .fontWeight(FontWeight.Bold)
          .fontColor('#111827')
          .width('100%')
        TextInput({ text: this.text, placeholder: this.placeholder })
          .fontSize(15)
          .height(44)
          .width('100%')
          .onChange((value: string) => {
            this.text = value;
          })
        Row({ space: 10 }) {
          Button($r('app.string.profile_cancel'))
            .fontSize(15)
            .fontWeight(FontWeight.Medium)
            .fontColor(getColors().inkSoft)
            .backgroundColor(getColors().subtle)
            .height(42)
            .layoutWeight(1)
            .enabled(!this.busy)
            .onClick(() => {
              this.onCancel();
            })
          Button(this.saveLabel)
            .fontSize(15)
            .fontWeight(FontWeight.Medium)
            .fontColor(getColors().onPrimaryAction)
            .backgroundColor(getColors().primaryAction)
            .height(42)
            .layoutWeight(1)
            .enabled(!this.busy)
            .onClick(() => {
              this.onSave(this.text);
            })
        }
        .width('100%')
      }
      .width('86%')
      .padding(18)
      .borderRadius(16)
      .backgroundColor(Color.White)
    }
    .width('100%')
    .height('100%')
  }
}
