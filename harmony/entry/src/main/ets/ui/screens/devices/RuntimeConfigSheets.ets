import { AAColors, AA_LIGHT_COLORS, withAlpha } from '../../designsystem/AAColors';
import { AAIcon } from '../../designsystem/AAIcon';
import { AA_ICONS } from '../../designsystem/AAIcons';
import { AABottomSheetColors, aaBottomSheetColors } from '../../designsystem/AABottomSheet';
import { AAIosGlassButton, AAIosPrimaryButton } from '../../designsystem/AAIosChrome';
import { AARadius } from '../../designsystem/AAMetrics';
import { resolveString } from '../../../common/AAResources';
import { RemoteDeviceRuntime, RemoteRuntimeType, runtimeTypeCanAdd } from '../../../api/DevicesDtos';
import { RuntimeConfigDraft, RuntimeConfigOutcome } from '../../../feature/devices/RuntimeConfigSchema';
import { RuntimeConfigForm, RuntimeConfigInput } from './RuntimeConfigForm';

/**
 * The two runtime configuration surfaces of the device page.
 *
 * Port of `Views/Devices/RuntimeConfigurationSheet.swift`,
 * `Views/Devices/AddDeviceAgentSheet.swift` and `DeviceAgentSection.swift`.
 *
 * Both are the app's `bindSheet` overlays: the screen opens the host sheet and
 * decides which of the two is drawn, so a runtime and the "add an Agent" flow
 * can never be open at once. The chrome (handle, header, scrolling body) is drawn
 * here rather than by the platform sheet, which is the same split the actions and
 * runtime-settings sheets in this port already use.
 *
 * The sheets own their own busy state because they await the app's write
 * callbacks; they report it upward so the host sheet can refuse a dismiss while a
 * request is in flight, exactly as the actions sheet's `actionBusy` does.
 */

/** The placeholder a type-less read answers with; only reachable mid-teardown. */
const EMPTY_RUNTIME_TYPE: RemoteRuntimeType = {
  connectorId: '',
  id: '',
  runtimeType: '',
  displayName: '',
  description: null,
  present: false,
  available: false,
  reason: null,
  recommended: false,
  recommendationRank: null,
  schema: null,
  uiSchema: null,
  defaults: JSON.parse('{}') as Object,
  instancePolicy: 'single',
  maxInstances: null,
};

// --------------------------------------------------------- configuration sheet

/**
 * The configuration form for one runtime, or for a type being added.
 *
 * Both iOS initialisers end up here: the runtime one edits the instance's saved
 * `config` and hides the name field, the type one seeds `defaults` only, shows
 * the name field and requires the `requiredForNamedInstance` fields.
 */
@Component
export struct RuntimeConfigurationSheet {
  colors: AAColors = AA_LIGHT_COLORS;
  /** iOS's navigation title: `Configure <name>`, or `Add Agent` for a type. */
  @Prop title: ResourceStr = '';
  /** The type's name, printed under the title. */
  @Prop subtitle: string = '';
  @Prop allowsNaming: boolean = false;
  @Prop initialName: string = '';
  @Prop saveLabel: ResourceStr = '';
  /** False when the device is offline: the form stays editable, the save does not. */
  @Prop canSave: boolean = true;
  /** The schema the draft is built from; read once, when the sheet appears. */
  schema: Object | null = null;
  uiSchema: Object | null = null;
  defaultValues: Object = JSON.parse('{}') as Object;
  configValues: Object | null = null;
  /** Adds `requiredForNamedInstance` to the required set, as iOS's `forNamedInstance`. */
  requiresNamedInstance: boolean = false;

  onSave: (name: string, config: Object) => Promise<void> =
    () => Promise.reject(new Error('Saving a runtime configuration is not connected.'));
  onDismiss: () => void = () => {};
  onBusyChanged: (busy: boolean) => void = () => {};

  private draft: RuntimeConfigDraft | null = null;
  @State private instanceName: string = '';
  @State private busy: boolean = false;
  @State private showErrors: boolean = false;
  /** Bumped whenever the editors have to re-read the draft. */
  @State private revision: number = 0;
  @State private errorMessage: string = '';

  aboutToAppear(): void {
    this.draft = RuntimeConfigDraft.create(
      this.schema, this.uiSchema, this.defaultValues, this.configValues,
      this.requiresNamedInstance,
    );
    this.instanceName = this.initialName;
  }

  private sheetColors(): AABottomSheetColors {
    return aaBottomSheetColors(this.colors);
  }

  private canSubmit(): boolean {
    if (!this.canSave || this.busy) {
      return false;
    }
    return !this.allowsNaming || this.instanceName.trim().length > 0;
  }

  private resetDefaults(): void {
    const draft: RuntimeConfigDraft | null = this.draft;
    if (draft === null || this.busy) {
      return;
    }
    draft.resetDefaults();
    this.showErrors = false;
    this.errorMessage = '';
    this.revision += 1;
  }

  /** iOS's `save()`: validate, write, and only then leave the sheet. */
  private async save(): Promise<void> {
    const draft: RuntimeConfigDraft | null = this.draft;
    if (draft === null || !this.canSubmit()) {
      return;
    }
    const name: string = this.instanceName.trim();
    const outcome: RuntimeConfigOutcome = draft.makeConfig();
    if (outcome.errors.size > 0) {
      this.showErrors = true;
      this.revision += 1;
      return;
    }
    this.busy = true;
    this.errorMessage = '';
    this.onBusyChanged(true);
    try {
      await this.onSave(name, outcome.config);
      this.busy = false;
      this.onBusyChanged(false);
      this.onDismiss();
    } catch (error) {
      this.busy = false;
      this.onBusyChanged(false);
      this.errorMessage = error instanceof Error
        ? error.message
        : resolveString($r('app.string.configure_agent_save_failed'));
    }
  }

  build() {
    Column() {
      Column() {
        Column()
          .width(36)
          .height(4)
          .borderRadius(2)
          .backgroundColor(this.sheetColors().handle)
      }
      .width('100%')
      .padding({ top: 12, bottom: 8 })
      .alignItems(HorizontalAlign.Center)

      Row({ space: 10 }) {
        Column({ space: 2 }) {
          Text(this.title)
            .fontSize(18)
            .lineHeight(24)
            .fontWeight(FontWeight.Bold)
            .fontColor(this.sheetColors().content)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')
          if (this.subtitle.length > 0) {
            Text(this.subtitle)
              .fontSize(12)
              .fontWeight(600)
              .fontColor(this.sheetColors().secondaryContent)
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .width('100%')
          }
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)

        Column() {
          AAIcon({
            commands: AA_ICONS.X,
            iconSize: 20,
            color: this.busy
              ? withAlpha(this.sheetColors().secondaryContent, 0.38)
              : this.sheetColors().secondaryContent,
          })
        }
        .width(48)
        .height(48)
        .justifyContent(FlexAlign.Center)
        .accessibilityText($r('app.string.common_close'))
        .onClick(() => {
          if (!this.busy) {
            this.onDismiss();
          }
        })
      }
      .width('100%')
      .constraintSize({ minHeight: 52 })
      .alignItems(VerticalAlign.Center)

      Scroll() {
        Column({ space: 20 }) {
          if (!this.canSave) {
            Row({ space: 8 }) {
              AAIcon({ commands: AA_ICONS.CIRCLE_ALERT, iconSize: 15, color: this.colors.muted })
              Text($r('app.string.device_agent_configuration_offline'))
                .fontSize(12)
                .lineHeight(16)
                .fontColor(this.colors.muted)
                .layoutWeight(1)
            }
            .width('100%')
            .alignItems(VerticalAlign.Center)
          }

          if (this.allowsNaming) {
            Column({ space: 6 }) {
              Text($r('app.string.runtime_config_instance_name'))
                .fontSize(13)
                .fontWeight(600)
                .fontColor(this.colors.muted)
                .width('100%')
              RuntimeConfigInput({
                colors: this.colors,
                value: this.instanceName,
                placeholder: $r('app.string.runtime_config_instance_name_placeholder'),
                fieldEnabled: !this.busy,
                secure: false,
                onValueChange: (next: string) => {
                  this.instanceName = next;
                },
              })
            }
            .width('100%')
            .alignItems(HorizontalAlign.Start)
          }

          RuntimeConfigForm({
            colors: this.colors,
            draft: this.draft,
            showErrors: this.showErrors,
            fieldEnabled: !this.busy,
            revision: this.revision,
          })

          if (this.errorMessage.length > 0) {
            Text(this.errorMessage)
              .fontSize(12.5)
              .lineHeight(17)
              .fontWeight(600)
              .fontColor(this.colors.errorText)
              .width('100%')
          }
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
        .padding({ top: 4, bottom: 20 })
      }
      .width('100%')
      .layoutWeight(1)
      .align(Alignment.Top)
      .scrollBar(BarState.Off)

      Row({ space: 10 }) {
        Column() {
          AAIosGlassButton({
            colors: this.colors,
            label: $r('app.string.runtime_config_reset_defaults'),
            iconCommands: AA_ICONS.REFRESH,
            loading: false,
            buttonEnabled: !this.busy,
            onTap: () => this.resetDefaults(),
          })
        }
        .layoutWeight(1)

        Column() {
          AAIosPrimaryButton({
            colors: this.colors,
            label: this.saveLabel,
            iconCommands: '',
            loading: this.busy,
            buttonEnabled: this.canSubmit(),
            onTap: () => {
              void this.save();
            },
          })
        }
        .layoutWeight(1)
      }
      .width('100%')
      .padding({ top: 10, bottom: 4 })
      .alignItems(VerticalAlign.Center)
    }
    .width('100%')
    .height('100%')
    // The host binds this sheet with a transparent sheet background so each
    // surface draws its own panel — which `AddDeviceAgentSheet` and
    // `DeviceActionsSheet` do, and this one did not: the page stayed visible
    // through the form, with its rows printing over the fields.
    .borderRadius({ topLeft: AARadius.SHEET, topRight: AARadius.SHEET })
    .backgroundColor(this.sheetColors().container)
    .padding({ left: 22, right: 22, bottom: 20 })
    .alignItems(HorizontalAlign.Start)
  }
}

// --------------------------------------------------------------- add-Agent sheet

/**
 * The "add an Agent" flow: the addable types, then one type's configuration.
 *
 * iOS presents them as two sheets; here the picked type swaps this sheet's body,
 * which keeps a single overlay and one busy latch. The addable rule is
 * `V2RuntimeInventory.canAdd` — present, configurable, and either a cleared
 * instance to configure again or room under the type's instance policy.
 */
@Component
export struct AddDeviceAgentSheet {
  colors: AAColors = AA_LIGHT_COLORS;
  /** The device's connection state; iOS's `model.connected`. */
  @Prop connected: boolean = false;
  @Prop runtimeTypes: RemoteRuntimeType[] = [];
  @Prop typesLoading: boolean = false;
  @Prop typesError: string | null = null;
  /** The device's runtime instances, which the addable rule counts. */
  @Prop instances: RemoteDeviceRuntime[] = [];
  onRediscover: () => void = () => {};
  onClose: () => void = () => {};
  onAddRuntime: (type: RemoteRuntimeType, name: string | null, config: Object, newInstance: boolean) =>
    Promise<void> = () => Promise.reject(new Error('Adding a runtime is not connected.'));
  onBusyChanged: (busy: boolean) => void = () => {};

  private sheetColors(): AABottomSheetColors {
    return aaBottomSheetColors(this.colors);
  }

  /** The type whose configuration page is open, or `null` for the list. */
  @State private configuring: RemoteRuntimeType | null = null;
  /** The type whose create request is in flight; only one at a time. */
  @State private busyTypeId: string = '';
  @State private errorMessage: string = '';

  /** iOS's `addableTypes`, in its recommendation order. */
  private addableTypes(): RemoteRuntimeType[] {
    const addable: RemoteRuntimeType[] = this.runtimeTypes.filter((type: RemoteRuntimeType) =>
      runtimeTypeCanAdd(type, this.instances));
    return addable.sort((left: RemoteRuntimeType, right: RemoteRuntimeType) => {
      if (left.recommended !== right.recommended) {
        return left.recommended ? -1 : 1;
      }
      const leftRank: number = left.recommendationRank ?? Number.MAX_SAFE_INTEGER;
      const rightRank: number = right.recommendationRank ?? Number.MAX_SAFE_INTEGER;
      if (leftRank !== rightRank) {
        return leftRank < rightRank ? -1 : 1;
      }
      return left.displayName < right.displayName ? -1 : (left.displayName > right.displayName ? 1 : 0);
    });
  }

  /** iOS's `suggestedName`: the type's name, then a numeric suffix. */
  private suggestedName(type: RemoteRuntimeType): string {
    const names: Set<string> = new Set();
    for (const instance of this.instances) {
      names.add(instance.displayName.toLowerCase());
    }
    let name: string = type.displayName;
    let suffix: number = 2;
    while (names.has(name.toLowerCase())) {
      name = `${type.displayName} ${suffix}`;
      suffix += 1;
    }
    return name;
  }

  private async quickAdd(type: RemoteRuntimeType): Promise<void> {
    if (this.busyTypeId.length > 0 || !this.connected) {
      return;
    }
    this.busyTypeId = type.id;
    this.errorMessage = '';
    this.onBusyChanged(true);
    try {
      await this.onAddRuntime(type, null, JSON.parse('{}') as Object, false);
      this.busyTypeId = '';
      this.onBusyChanged(false);
      this.onClose();
    } catch (error) {
      this.busyTypeId = '';
      this.onBusyChanged(false);
      this.errorMessage = error instanceof Error
        ? error.message
        : resolveString($r('app.string.device_add_agent_failed'));
    }
  }

  private async submitConfiguration(
    type: RemoteRuntimeType,
    name: string,
    config: Object,
  ): Promise<void> {
    await this.onAddRuntime(type, name, config, true);
    this.configuring = null;
    this.onClose();
  }

  /** The type being configured, as the sheet's read-only props. A cast would do
   * the same, but these keep the builder free of type assertions. */
  private configuringType(): RemoteRuntimeType {
    const type: RemoteRuntimeType | null = this.configuring;
    return type === null ? EMPTY_RUNTIME_TYPE : type;
  }

  build() {
    Column() {
      if (this.configuring === null) {
        this.TypeList()
      } else {
        RuntimeConfigurationSheet({
          colors: this.colors,
          title: $r('app.string.device_add_agent_title'),
          subtitle: this.configuringType().displayName,
          allowsNaming: true,
          initialName: this.suggestedName(this.configuringType()),
          saveLabel: $r('app.string.runtime_config_add_action'),
          canSave: this.connected,
          schema: this.configuringType().schema,
          uiSchema: this.configuringType().uiSchema,
          defaultValues: this.configuringType().defaults,
          configValues: null,
          requiresNamedInstance: true,
          onSave: (name: string, config: Object) =>
            this.submitConfiguration(this.configuringType(), name, config),
          // iOS dismisses the configuration sheet back to the type list, so the
          // user can pick another Agent without leaving the flow.
          onDismiss: () => {
            if (this.busyTypeId.length === 0) {
              this.configuring = null;
            }
          },
          onBusyChanged: (busy: boolean) => this.onBusyChanged(busy),
        })
      }
    }
    .width('100%')
    .height('100%')
    .borderRadius({ topLeft: AARadius.SHEET, topRight: AARadius.SHEET })
    .clip(true)
    .backgroundColor(this.sheetColors().container)
  }

  @Builder
  TypeList() {
    Column() {
      Column() {
        Column()
          .width(36)
          .height(4)
          .borderRadius(2)
          .backgroundColor(this.sheetColors().handle)
      }
      .width('100%')
      .padding({ top: 12, bottom: 8 })
      .alignItems(HorizontalAlign.Center)

      Row({ space: 10 }) {
        Text($r('app.string.device_add_agent_title'))
          .fontSize(18)
          .lineHeight(24)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.sheetColors().content)
          .layoutWeight(1)

        // iOS puts rediscovery in the sheet's toolbar, with its own spinner while
        // the discovery call is in flight.
        Column() {
          if (this.typesLoading) {
            LoadingProgress().width(18).height(18).color(this.sheetColors().content)
          } else {
            AAIcon({
              commands: AA_ICONS.REFRESH,
              iconSize: 20,
              color: withAlpha(this.sheetColors().secondaryContent,
                this.busyTypeId.length > 0 ? 0.4 : 1),
            })
          }
        }
        .width(44)
        .height(44)
        .justifyContent(FlexAlign.Center)
        .accessibilityText(this.typesLoading
          ? $r('app.string.device_agent_rediscovering')
          : $r('app.string.device_agent_rediscover'))
        .onClick(() => {
          if (!this.typesLoading && this.busyTypeId.length === 0) {
            this.onRediscover();
          }
        })

        Column() {
          AAIcon({
            commands: AA_ICONS.X,
            iconSize: 20,
            color: this.busyTypeId.length > 0
              ? withAlpha(this.sheetColors().secondaryContent, 0.38)
              : this.sheetColors().secondaryContent,
          })
        }
        .width(48)
        .height(48)
        .justifyContent(FlexAlign.Center)
        .accessibilityText($r('app.string.common_close'))
        .onClick(() => {
          if (this.busyTypeId.length === 0) {
            this.onClose();
          }
        })
      }
      .width('100%')
      .constraintSize({ minHeight: 52 })
      .alignItems(VerticalAlign.Center)

      Scroll() {
        Column({ space: 12 }) {
          if (!this.connected) {
            Row({ space: 8 }) {
              AAIcon({ commands: AA_ICONS.CIRCLE_ALERT, iconSize: 15, color: this.colors.muted })
              Text($r('app.string.device_add_agent_offline'))
                .fontSize(12)
                .lineHeight(16)
                .fontColor(this.colors.muted)
                .layoutWeight(1)
            }
            .width('100%')
            .alignItems(VerticalAlign.Center)
          }

          if (this.typesError !== null) {
            Text(this.typesError)
              .fontSize(12.5)
              .lineHeight(17)
              .fontWeight(600)
              .fontColor(this.colors.errorText)
              .width('100%')
          }

          ForEach(this.addableTypes(), (type: RemoteRuntimeType) => {
            this.TypeCard(type)
          }, (type: RemoteRuntimeType) => `add-type-${type.id}-${this.busyTypeId}`)

          if (this.typesLoading && this.addableTypes().length === 0) {
            Row({ space: 10 }) {
              LoadingProgress().width(16).height(16).color(this.colors.ink)
              Text($r('app.string.new_session_checking_agents'))
                .fontSize(13)
                .fontColor(this.colors.muted)
            }
            .width('100%')
            .constraintSize({ minHeight: 44 })
            .alignItems(VerticalAlign.Center)
          }

          if (this.addableTypes().length === 0 && !this.typesLoading) {
            Text(this.runtimeTypes.length === 0
              ? $r('app.string.device_add_agent_none_discovered')
              : $r('app.string.device_add_agent_none_addable'))
              .fontSize(13)
              .lineHeight(18)
              .fontColor(this.colors.muted)
              .width('100%')
          }

          if (this.errorMessage.length > 0) {
            Text(this.errorMessage)
              .fontSize(12.5)
              .lineHeight(17)
              .fontWeight(600)
              .fontColor(this.colors.errorText)
              .width('100%')
          }
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
        .padding({ top: 4, bottom: 24 })
      }
      .width('100%')
      .layoutWeight(1)
      .align(Alignment.Top)
      .scrollBar(BarState.Off)
    }
    .width('100%')
    .height('100%')
    .padding({ left: 22, right: 22 })
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  TypeCard(type: RemoteRuntimeType) {
    Column({ space: 12 }) {
      Row({ space: 8 }) {
        Text(type.displayName)
          .fontSize(17)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.colors.ink)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        if (type.recommended) {
          Text($r('app.string.device_agent_recommended'))
            .fontSize(11)
            .fontColor(this.colors.muted)
        }
        Blank()
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      if (this.typeCaption(type).length > 0) {
        Text(this.typeCaption(type))
          .fontSize(12)
          .lineHeight(16)
          .fontColor(this.colors.muted)
          .width('100%')
      }

      Row({ space: 12 }) {
        Column() {
          AAIosPrimaryButton({
            colors: this.colors,
            label: $r('app.string.device_add_agent_quick_add'),
            iconCommands: AA_ICONS.PLUS,
            loading: this.busyTypeId === type.id,
            buttonEnabled: this.connected && this.busyTypeId.length === 0,
            onTap: () => {
              void this.quickAdd(type);
            },
          })
        }
        .layoutWeight(1)

        Column() {
          AAIosGlassButton({
            colors: this.colors,
            label: $r('app.string.device_agent_configure'),
            iconCommands: '',
            loading: false,
            buttonEnabled: this.connected && this.busyTypeId.length === 0,
            onTap: () => {
              this.errorMessage = '';
              this.configuring = type;
            },
          })
        }
        .layoutWeight(1)
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)
    }
    .width('100%')
    .padding(16)
    .borderRadius(AARadius.CARD)
    .backgroundColor(this.colors.isDark ? this.colors.subtle : this.colors.raisedSurface)
    .border({ width: 1, color: this.colors.border })
    .alignItems(HorizontalAlign.Start)
  }

  /** iOS shows `reason ?? description`, with the reason winning when present. */
  private typeCaption(type: RemoteRuntimeType): string {
    if (type.reason !== null && type.reason.length > 0) {
      return type.reason;
    }
    return type.description === null ? '' : type.description;
  }
}
