@Entry
@Component
struct Index {
  build() {
    Column() {
      Text($r('app.string.EntryAbility_label'))
        .fontSize(24)
        .fontWeight(FontWeight.Bold)
    }
    .justifyContent(FlexAlign.Center)
    .width('100%')
    .height('100%')
  }
}
