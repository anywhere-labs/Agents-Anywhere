import { AAColors, AA_LIGHT_COLORS } from '../../designsystem/AAColors';
import { RuntimeCommand, matchingCommands } from '../../../feature/sessiondetail/RuntimeCommandsState';

/**
 * The slash-command suggestion panel.
 *
 * Port of `RuntimeCommandSuggestions` in
 * `ui/screens/sessiondetail/SessionRuntimeControls.kt`: an 18dp-radius card in the
 * canvas colour at 98% over a 1dp border, 10dp of padding and 4dp between rows.
 * It shows one of four states — loading, an error with a retry, "no matches", or
 * up to six rows — and each row is `/<id>  <title>` with the description (or the
 * disabled reason) underneath.
 *
 * The caller decides what is shown; this component only draws it.
 */
@Component
export struct RuntimeCommandSuggestions {
  colors: AAColors = AA_LIGHT_COLORS;
  /** The whole catalog; the filter and the six-row cap happen here. */
  commands: RuntimeCommand[] = [];
  query: string = '';
  loading: boolean = false;
  errorMessage: string = '';
  onRetry: () => void = () => {};
  onSelect: (command: RuntimeCommand) => void = () => {};

  /** Android's `remember(commands, query) { commands.filter { it.matches(query) }.take(6) }`. */
  private matches(): RuntimeCommand[] {
    return matchingCommands(this.commands, this.query);
  }

  build() {
    Column({ space: 4 }) {
      if (this.loading) {
        Text($r('app.string.session_commands_loading'))
          .fontSize(13)
          .fontColor(this.colors.muted)
      } else if (this.errorMessage.length > 0) {
        Text(this.errorMessage)
          .fontSize(13)
          .lineHeight(17)
          .fontColor(this.colors.errorText)
          .width('100%')

        Text($r('app.string.common_retry'))
          .fontSize(13)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.colors.primaryAction)
          .onClick(() => this.onRetry())
      } else if (this.matches().length === 0) {
        Text($r('app.string.session_commands_empty'))
          .fontSize(13)
          .fontColor(this.colors.muted)
      } else {
        ForEach(this.matches(), (command: RuntimeCommand) => {
          Column() {
            Text(`/${command.id}  ${command.title}`)
              .fontSize(14)
              .fontWeight(600)
              .fontColor(this.colors.ink)
              .opacity(command.enabled ? 1 : 0.45)
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .width('100%')

            if (this.subtitle(command).length > 0) {
              Text(this.subtitle(command))
                .fontSize(12)
                .lineHeight(16)
                .fontColor(this.colors.muted)
                .maxLines(2)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
                .width('100%')
            }
          }
          .width('100%')
          .padding({ left: 10, right: 10, top: 8, bottom: 8 })
          .borderRadius(10)
          .alignItems(HorizontalAlign.Start)
          .onClick(() => this.onSelect(command))
        }, (command: RuntimeCommand) => `command-${command.id}`)
      }
    }
    .width('100%')
    .padding(10)
    .borderRadius(18)
    .backgroundColor(this.colors.canvas)
    .opacity(0.98)
    .border({ width: 1, color: this.colors.border })
    .alignItems(HorizontalAlign.Start)
  }

  /** Android shows the disabled reason in place of the description. */
  private subtitle(command: RuntimeCommand): string {
    const disabled: string | null = command.disabledReason;
    if (disabled !== null && disabled.length > 0) {
      return disabled;
    }
    const description: string | null = command.description;
    return description === null ? '' : description;
  }
}
