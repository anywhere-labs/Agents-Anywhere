import { AAColors, AA_LIGHT_COLORS, withAlpha } from '../../designsystem/AAColors';
import { AAIcon } from '../../designsystem/AAIcon';
import { AA_ICONS } from '../../designsystem/AAIcons';
import { AADropdownMenu, AADropdownMenuItemSpec } from '../../designsystem/AADropdownMenu';
import { AAFontSize, AARadius } from '../../designsystem/AAMetrics';
import {
  RuntimeConfigDraft, RuntimeConfigField, RuntimeConfigFieldKind, RuntimeConfigOption,
  RuntimeEnvRow, RuntimeEffortRow, RuntimeGatewayDraft, RuntimeModelRow,
} from '../../../feature/devices/RuntimeConfigSchema';
import { resolveText } from '../../../common/AAResources';

/**
 * The JSON-schema-driven runtime configuration form.
 *
 * Port of `Views/Devices/RuntimeConfigurationFieldView.swift` and
 * `RuntimeConfigurationRowEditors.swift`.
 *
 * One editor component serves every field: the ForEach laying the fields out
 * keys each editor by the field id plus the sheet's revision, so the editors are
 * rebuilt — and re-seeded from the draft — exactly when the sheet resets the
 * values or reveals its validation messages, and never while the user types.
 * Inside an editor the `keyValue` and `customModels` rows are mutable objects
 * owned by the draft; a row's list carries its own revision in the ForEach key,
 * which is how an add or a remove rebuilds the list while the row being typed in
 * keeps its text.
 */

// ----------------------------------------------------------- labels and copy

/**
 * `metadata.i18n.labelKey` and friends, as this app's resources.
 *
 * The schema's i18n keys are the localization keys the Web, iOS and Connector
 * share; ArkUI resources are declared under their own names, so every known key
 * is mapped here. An unknown key falls back to the schema's own English title,
 * which is what iOS's `RuntimeConfigCopy.schemaText` does when a lookup returns
 * the key unchanged.
 */
function runtimeConfigKeyResource(key: string): Resource | null {
  if (key === 'dashboard.device.runtimeConfigComponents.modelGateway.label') {
    return $r('app.string.runtime_config_model_gateway_label');
  }
  if (key === 'dashboard.device.runtimeConfigComponents.modelGateway.description') {
    return $r('app.string.runtime_config_model_gateway_description');
  }
  if (key === 'dashboard.device.runtimeConfigComponents.modelGateway.requiredLabel') {
    return $r('app.string.runtime_config_model_gateway_required_label');
  }
  if (key === 'dashboard.device.runtimeConfigComponents.modelGateway.requiredDescription') {
    return $r('app.string.runtime_config_model_gateway_required_description');
  }
  if (key === 'dashboard.device.runtimeConfigComponents.keyValue.label') {
    return $r('app.string.runtime_config_key_value_label');
  }
  if (key === 'dashboard.device.runtimeConfigComponents.keyValue.description') {
    return $r('app.string.runtime_config_key_value_description');
  }
  if (key === 'dashboard.device.runtimeConfigComponents.customModels.label') {
    return $r('app.string.runtime_config_custom_models_label');
  }
  if (key === 'dashboard.device.runtimeConfigComponents.customModels.description') {
    return $r('app.string.runtime_config_custom_models_description');
  }
  if (key === 'dashboard.device.runtimeConfigFields.useSystemCodex.label') {
    return $r('app.string.runtime_config_use_system_codex_label');
  }
  if (key === 'dashboard.device.runtimeConfigFields.useSystemCodex.description') {
    return $r('app.string.runtime_config_use_system_codex_description');
  }
  if (key === 'dashboard.device.runtimeConfigFields.codexExecutablePath.label') {
    return $r('app.string.runtime_config_codex_executable_path_label');
  }
  if (key === 'dashboard.device.runtimeConfigFields.codexExecutablePath.description') {
    return $r('app.string.runtime_config_codex_executable_path_description');
  }
  if (key === 'dashboard.device.runtimeConfigFields.codexHome.label') {
    return $r('app.string.runtime_config_codex_home_label');
  }
  if (key === 'dashboard.device.runtimeConfigFields.codexHome.description') {
    return $r('app.string.runtime_config_codex_home_description');
  }
  if (key === 'dashboard.device.runtimeConfigFields.claudeExecutablePath.label') {
    return $r('app.string.runtime_config_claude_executable_path_label');
  }
  if (key === 'dashboard.device.runtimeConfigFields.claudeExecutablePath.description') {
    return $r('app.string.runtime_config_claude_executable_path_description');
  }
  if (key === 'dashboard.device.runtimeConfigFields.modelGatewayBaseUrl.label') {
    return $r('app.string.runtime_config_model_gateway_url_label');
  }
  if (key === 'dashboard.device.runtimeConfigFields.modelGatewayBaseUrl.description') {
    return $r('app.string.runtime_config_model_gateway_url_description');
  }
  if (key === 'dashboard.device.runtimeConfigFields.modelGatewayApiKey.label') {
    return $r('app.string.runtime_config_model_gateway_key_label');
  }
  if (key === 'dashboard.device.runtimeConfigFields.modelGatewayApiKey.description') {
    return $r('app.string.runtime_config_model_gateway_key_description');
  }
  return null;
}

/** iOS `RuntimeConfigCopy.title`: the bespoke editors own their copy. */
function runtimeConfigFieldLabel(field: RuntimeConfigField): ResourceStr {
  if (field.kind === RuntimeConfigFieldKind.MODEL_GATEWAY && field.required) {
    return $r('app.string.runtime_config_model_gateway_required_label');
  }
  const mapped: Resource | null = runtimeConfigKeyResource(field.labelKey);
  if (mapped !== null) {
    return mapped;
  }
  if (field.kind === RuntimeConfigFieldKind.MODEL_GATEWAY) {
    return $r('app.string.runtime_config_model_gateway_label');
  }
  if (field.kind === RuntimeConfigFieldKind.KEY_VALUE) {
    return $r('app.string.runtime_config_key_value_label');
  }
  if (field.kind === RuntimeConfigFieldKind.CUSTOM_MODELS) {
    return $r('app.string.runtime_config_custom_models_label');
  }
  return field.title;
}

/** The same for the footer line; `null` when there is nothing to show. */
function runtimeConfigFieldDescription(field: RuntimeConfigField): ResourceStr | null {
  if (field.kind === RuntimeConfigFieldKind.MODEL_GATEWAY && field.required) {
    return $r('app.string.runtime_config_model_gateway_required_description');
  }
  const mapped: Resource | null = runtimeConfigKeyResource(field.descriptionKey);
  if (mapped !== null) {
    return mapped;
  }
  if (field.kind === RuntimeConfigFieldKind.MODEL_GATEWAY) {
    return $r('app.string.runtime_config_model_gateway_description');
  }
  if (field.kind === RuntimeConfigFieldKind.KEY_VALUE) {
    return $r('app.string.runtime_config_key_value_description');
  }
  if (field.kind === RuntimeConfigFieldKind.CUSTOM_MODELS) {
    return $r('app.string.runtime_config_custom_models_description');
  }
  return field.description.length > 0 ? field.description : null;
}

/**
 * The model gateway's two sub-field labels.
 *
 * iOS reads them from the field's own `properties.<name>.metadata.i18n`, so a
 * Connector that renames its gateway fields keeps the localized wording.
 */
function runtimeConfigGatewaySubText(
  field: RuntimeConfigField,
  property: string,
  key: string,
  fallback: ResourceStr,
): ResourceStr {
  const schema: Record<string, Object> = field.schema as Record<string, Object>;
  const properties: Object | undefined = schema['properties'];
  if (properties === undefined || properties === null) {
    return fallback;
  }
  const sub: Object | undefined = (properties as Record<string, Object>)[property];
  if (sub === undefined || sub === null) {
    return fallback;
  }
  const metadata: Object | undefined = (sub as Record<string, Object>)['metadata'];
  if (metadata === undefined || metadata === null) {
    return fallback;
  }
  const i18n: Object | undefined = (metadata as Record<string, Object>)['i18n'];
  if (i18n === undefined || i18n === null) {
    return fallback;
  }
  const value: Object | undefined = (i18n as Record<string, Object>)[key];
  if (typeof value !== 'string') {
    return fallback;
  }
  const mapped: Resource | null = runtimeConfigKeyResource(value);
  return mapped === null ? fallback : mapped;
}

// ------------------------------------------------------------------ the form

/**
 * The ordered field list.
 *
 * `revision` is the sheet's own counter: it changes when the draft is reset or
 * when validation messages appear, and it is part of every editor's ForEach key
 * so those editors are rebuilt against the new draft state.
 */
@Component
export struct RuntimeConfigForm {
  colors: AAColors = AA_LIGHT_COLORS;
  /** The one draft every editor reads and writes; never replaced in place. */
  draft: RuntimeConfigDraft | null = null;
  @Prop showErrors: boolean = false;
  @Prop fieldEnabled: boolean = true;
  @Prop revision: number = 0;

  private fields(): RuntimeConfigField[] {
    const draft: RuntimeConfigDraft | null = this.draft;
    return draft === null ? [] : draft.fields;
  }

  build() {
    Column({ space: 22 }) {
      ForEach(this.fields(), (field: RuntimeConfigField) => {
        RuntimeConfigFieldEditor({
          colors: this.colors,
          field: field,
          draft: this.draft,
          showErrors: this.showErrors,
          fieldEnabled: this.fieldEnabled,
        })
      }, (field: RuntimeConfigField) =>
        `config-field-${field.id}-${this.revision}-${this.fieldEnabled}`)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }
}

/** One field: its caption, its editor, its message and its footer. */
@Component
struct RuntimeConfigFieldEditor {
  colors: AAColors = AA_LIGHT_COLORS;
  @Prop field: RuntimeConfigField = new RuntimeConfigField(
    '', '', '', false, RuntimeConfigFieldKind.TEXT, false, [], JSON.parse('{}') as Object,
    false, null, '', '',
  );
  draft: RuntimeConfigDraft | null = null;
  @Prop showErrors: boolean = false;
  @Prop fieldEnabled: boolean = true;

  /** Text, number and JSON bodies share this draft string. */
  @State private text: string = '';
  @State private booleanValue: boolean = false;
  @State private choiceId: string = '';
  @State private choiceOpen: boolean = false;
  @State private gatewayBaseUrl: string = '';
  @State private gatewayApiKey: string = '';
  /** Env and custom-model rows, plus the counter their ForEach keys carry. */
  @State private envRows: RuntimeEnvRow[] = [];
  @State private modelRows: RuntimeModelRow[] = [];
  @State private rowRevision: number = 0;

  aboutToAppear(): void {
    const draft: RuntimeConfigDraft | null = this.draft;
    if (draft === null) {
      return;
    }
    const field: RuntimeConfigField = this.field;
    const kind: string = field.kind;
    if (kind === RuntimeConfigFieldKind.TEXT || kind === RuntimeConfigFieldKind.NUMBER
      || kind === RuntimeConfigFieldKind.JSON) {
      this.text = draft.text(field.id);
    } else if (kind === RuntimeConfigFieldKind.BOOLEAN) {
      this.booleanValue = draft.boolean(field.id);
    } else if (kind === RuntimeConfigFieldKind.CHOICE) {
      this.choiceId = draft.choiceId(field.id);
    } else if (kind === RuntimeConfigFieldKind.MODEL_GATEWAY) {
      const gateway: RuntimeGatewayDraft = draft.gateway(field.id);
      this.gatewayBaseUrl = gateway.baseUrl;
      this.gatewayApiKey = gateway.apiKey;
    } else if (kind === RuntimeConfigFieldKind.KEY_VALUE) {
      this.envRows = draft.envRows(field.id);
    } else if (kind === RuntimeConfigFieldKind.CUSTOM_MODELS) {
      this.modelRows = draft.modelRows(field.id);
    }
  }

  /** The message shown under this field, once the sheet has revealed errors. */
  private errorText(): ResourceStr | null {
    const draft: RuntimeConfigDraft | null = this.draft;
    if (!this.showErrors || draft === null) {
      return null;
    }
    return draft.errorFor(this.field);
  }

  /** The selected enum entry, resolved from the editor's own selection state. */
  private selectedOption(): RuntimeConfigOption | null {
    for (const option of this.field.options) {
      if (option.id === this.choiceId) {
        return option;
      }
    }
    return null;
  }

  private choiceItems(): AADropdownMenuItemSpec[] {
    const items: AADropdownMenuItemSpec[] = [];
    for (const option of this.field.options) {
      items.push(new AADropdownMenuItemSpec(option.id, option.title));
    }
    return items;
  }

  /** A structural row change: rebuild the list and hand it to the draft. */
  private updateEnvRows(next: RuntimeEnvRow[]): void {
    this.envRows = next;
    this.rowRevision += 1;
    const draft: RuntimeConfigDraft | null = this.draft;
    if (draft !== null) {
      draft.setEnvRows(this.field.id, next);
    }
  }

  private updateModelRows(next: RuntimeModelRow[]): void {
    this.modelRows = next;
    this.rowRevision += 1;
    const draft: RuntimeConfigDraft | null = this.draft;
    if (draft !== null) {
      draft.setModelRows(this.field.id, next);
    }
  }

  /** A row's own edit: the object is mutated, so nothing is rebuilt. */
  private touchEnvRows(): void {
    const draft: RuntimeConfigDraft | null = this.draft;
    if (draft !== null) {
      draft.setEnvRows(this.field.id, this.envRows);
    }
  }

  private touchModelRows(): void {
    const draft: RuntimeConfigDraft | null = this.draft;
    if (draft !== null) {
      draft.setModelRows(this.field.id, this.modelRows);
    }
  }

  build() {
    Column({ space: 8 }) {
      if (this.field.kind === RuntimeConfigFieldKind.BOOLEAN) {
        this.BooleanField()
      } else {
        Text(this.CaptionText())
          .fontSize(13)
          .fontWeight(600)
          .fontColor(this.colors.muted)
          .width('100%')

        if (this.field.kind === RuntimeConfigFieldKind.TEXT
          || this.field.kind === RuntimeConfigFieldKind.NUMBER) {
          this.TextField()
        } else if (this.field.kind === RuntimeConfigFieldKind.JSON) {
          this.JsonField()
        } else if (this.field.kind === RuntimeConfigFieldKind.CHOICE) {
          this.ChoiceField()
        } else if (this.field.kind === RuntimeConfigFieldKind.MODEL_GATEWAY) {
          this.GatewayField()
        } else if (this.field.kind === RuntimeConfigFieldKind.KEY_VALUE) {
          this.KeyValueField()
        } else {
          this.CustomModelsField()
        }
      }

      if (this.errorText() !== null) {
        Text(this.errorText())
          .fontSize(12.5)
          .lineHeight(17)
          .fontWeight(600)
          .fontColor(this.colors.errorText)
          .width('100%')
      }

      if (this.field.kind !== RuntimeConfigFieldKind.BOOLEAN
        && runtimeConfigFieldDescription(this.field) !== null) {
        Text(runtimeConfigFieldDescription(this.field))
          .fontSize(12)
          .lineHeight(16)
          .fontColor(this.colors.muted)
          .width('100%')
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .opacity(this.fieldEnabled ? 1 : 0.55)
  }

  /**
   * The caption as text.
   *
   * A `ResourceStr` cannot carry iOS's `" *"` suffix, so the label is resolved
   * to a string first — the same route the page's other interpolated labels take.
   */
  private CaptionText(): string {
    const label: string = resolveText(runtimeConfigFieldLabel(this.field));
    return this.field.required ? `${label} *` : label;
  }

  // ------------------------------------------------------------------ editors

  @Builder
  TextField() {
    RuntimeConfigInput({
      colors: this.colors,
      value: this.text,
      // iOS's placeholder is the field's own default when it has one, and the
      // title otherwise — a *primitive* default, since an object one has no text.
      placeholder: this.defaultPlaceholder(),
      fieldEnabled: this.fieldEnabled,
      secure: this.field.secure,
      onValueChange: (next: string) => {
        this.text = next;
        const draft: RuntimeConfigDraft | null = this.draft;
        if (draft !== null) {
          draft.setText(this.field.id, next);
        }
      },
    })
  }

  private defaultPlaceholder(): ResourceStr {
    if (this.field.hasDefault) {
      const value: Object | null = this.field.defaultValue;
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
      }
    }
    return this.field.title;
  }

  @Builder
  JsonField() {
    TextArea({ text: this.text, placeholder: '{ }' })
      .fontSize(13)
      .fontFamily('monospace')
      .fontColor(this.colors.ink)
      .backgroundColor(this.colors.subtle)
      .borderRadius(AARadius.CHIP)
      .border({ width: 1, color: this.colors.border })
      .constraintSize({ minHeight: 140 })
      .padding(12)
      .enabled(this.fieldEnabled)
      .onChange((next: string) => {
        this.text = next;
        const draft: RuntimeConfigDraft | null = this.draft;
        if (draft !== null) {
          draft.setText(this.field.id, next);
        }
      })
  }

  @Builder
  BooleanField() {
    Row() {
      Text(resolveText(runtimeConfigFieldLabel(this.field)))
        .fontSize(15)
        .fontWeight(500)
        .fontColor(this.colors.ink)
        .maxLines(2)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)

      Toggle({ type: ToggleType.Switch, isOn: this.booleanValue })
        .selectedColor(this.colors.noticeSuccess)
        .enabled(this.fieldEnabled)
        .onChange((isOn: boolean) => {
          this.booleanValue = isOn;
          const draft: RuntimeConfigDraft | null = this.draft;
          if (draft !== null) {
            draft.setBoolean(this.field.id, isOn);
          }
        })
    }
    .width('100%')
    .constraintSize({ minHeight: 44 })
    .alignItems(VerticalAlign.Center)
  }

  @Builder
  ChoiceField() {
    Row({ space: 8 }) {
      Text(this.selectedOption() === null
        ? $r('app.string.runtime_config_choose_option')
        : (this.selectedOption() as RuntimeConfigOption).title)
        .fontSize(15)
        .fontWeight(500)
        .fontColor(this.colors.ink)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
      AAIcon({ commands: AA_ICONS.CHEVRONS_UP_DOWN, iconSize: 16, color: this.colors.muted })
    }
    .width('100%')
    .height(44)
    .padding({ left: 12, right: 12 })
    .borderRadius(AARadius.CHIP)
    .backgroundColor(this.colors.subtle)
    .border({ width: 1, color: this.colors.border })
    .alignItems(VerticalAlign.Center)
    .onClick(() => {
      if (this.fieldEnabled) {
        this.choiceOpen = !this.choiceOpen;
      }
    })
    .bindMenu(this.choiceOpen, this.ChoiceMenu(), {
      placement: Placement.BottomLeft,
      enableArrow: false,
      onDisappear: () => {
        this.choiceOpen = false;
      },
    })
  }

  @Builder
  ChoiceMenu() {
    AADropdownMenu({
      colors: this.colors,
      items: this.choiceItems(),
      selectedId: this.choiceId,
      onSelect: (id: string) => {
        this.choiceId = id;
        const draft: RuntimeConfigDraft | null = this.draft;
        if (draft !== null) {
          draft.setChoice(this.field.id, id);
        }
      },
      onDismiss: () => {
        this.choiceOpen = false;
      },
    })
  }

  @Builder
  GatewayField() {
    Column({ space: 16 }) {
      Column({ space: 6 }) {
        Text(runtimeConfigGatewaySubText(this.field, 'baseUrl', 'labelKey',
          $r('app.string.runtime_config_model_gateway_url_label')))
          .fontSize(13)
          .fontWeight(600)
          .fontColor(this.colors.muted)
          .width('100%')
        RuntimeConfigInput({
          colors: this.colors,
          value: this.gatewayBaseUrl,
          placeholder: 'https://',
          fieldEnabled: this.fieldEnabled,
          secure: false,
          onValueChange: (next: string) => {
            this.gatewayBaseUrl = next;
            const draft: RuntimeConfigDraft | null = this.draft;
            if (draft !== null) {
              draft.setGateway(this.field.id, next, this.gatewayApiKey);
            }
          },
        })
        Text(runtimeConfigGatewaySubText(this.field, 'baseUrl', 'descriptionKey',
          $r('app.string.runtime_config_model_gateway_url_description')))
          .fontSize(12)
          .lineHeight(16)
          .fontColor(this.colors.muted)
          .width('100%')
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)

      Column({ space: 6 }) {
        Text(runtimeConfigGatewaySubText(this.field, 'apiKey', 'labelKey',
          $r('app.string.runtime_config_model_gateway_key_label')))
          .fontSize(13)
          .fontWeight(600)
          .fontColor(this.colors.muted)
          .width('100%')
        RuntimeConfigInput({
          colors: this.colors,
          value: this.gatewayApiKey,
          placeholder: '',
          fieldEnabled: this.fieldEnabled,
          secure: true,
          onValueChange: (next: string) => {
            this.gatewayApiKey = next;
            const draft: RuntimeConfigDraft | null = this.draft;
            if (draft !== null) {
              draft.setGateway(this.field.id, this.gatewayBaseUrl, next);
            }
          },
        })
        Text(runtimeConfigGatewaySubText(this.field, 'apiKey', 'descriptionKey',
          $r('app.string.runtime_config_model_gateway_key_description')))
          .fontSize(12)
          .lineHeight(16)
          .fontColor(this.colors.muted)
          .width('100%')
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  KeyValueField() {
    Column({ space: 10 }) {
      if (this.envRows.length === 0) {
        Text($r('app.string.runtime_config_key_value_empty'))
          .fontSize(13)
          .fontColor(this.colors.muted)
          .width('100%')
      }

      ForEach(this.envRows, (row: RuntimeEnvRow) => {
        Column({ space: 8 }) {
          Row({ space: 8 }) {
            Column() {
              RuntimeConfigInput({
                colors: this.colors,
                value: row.key,
                placeholder: $r('app.string.runtime_config_key_value_variable_name'),
                fieldEnabled: this.fieldEnabled,
                secure: false,
                onValueChange: (next: string) => {
                  row.key = next;
                  this.touchEnvRows();
                },
              })
            }
            .layoutWeight(1)

            RuntimeConfigIconButton({
              colors: this.colors,
              commands: AA_ICONS.TRASH,
              danger: true,
              fieldEnabled: this.fieldEnabled,
              label: $r('app.string.runtime_config_key_value_remove'),
              onTap: () => {
                this.updateEnvRows(this.envRows.filter((item: RuntimeEnvRow) => item.id !== row.id));
              },
            })
          }
          .width('100%')
          .alignItems(VerticalAlign.Center)

          RuntimeConfigInput({
            colors: this.colors,
            value: row.value,
            placeholder: $r('app.string.runtime_config_key_value_variable_value'),
            fieldEnabled: this.fieldEnabled && !row.removesInherited,
            secure: false,
            onValueChange: (next: string) => {
              row.value = next;
              this.touchEnvRows();
            },
          })

          Row({ space: 8 }) {
            Text($r('app.string.runtime_config_key_value_remove_inherited'))
              .fontSize(12.5)
              .fontWeight(600)
              .fontColor(this.colors.muted)
              .layoutWeight(1)
            Toggle({ type: ToggleType.Switch, isOn: row.removesInherited })
              .selectedColor(this.colors.noticeSuccess)
              .enabled(this.fieldEnabled)
              .onChange((isOn: boolean) => {
                // The value field's enabled state follows this flag, so the row
                // is rebuilt rather than only mutated.
                row.removesInherited = isOn;
                this.updateEnvRows(this.envRows);
              })
          }
          .width('100%')
          .constraintSize({ minHeight: 40 })
          .alignItems(VerticalAlign.Center)
        }
        .width('100%')
        .padding(10)
        .borderRadius(AARadius.CHIP)
        .backgroundColor(this.colors.raisedSurface)
        .border({ width: 1, color: this.colors.border })
        .alignItems(HorizontalAlign.Start)
      }, (row: RuntimeEnvRow) => `config-env-${row.id}-${this.rowRevision}`)

      RuntimeConfigAddButton({
        colors: this.colors,
        label: $r('app.string.runtime_config_key_value_add'),
        fieldEnabled: this.fieldEnabled,
        onTap: () => {
          this.updateEnvRows(this.envRows.concat([new RuntimeEnvRow()]));
        },
      })
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  CustomModelsField() {
    Column({ space: 12 }) {
      if (this.modelRows.length === 0) {
        Text($r('app.string.runtime_config_custom_models_empty'))
          .fontSize(13)
          .fontColor(this.colors.muted)
          .width('100%')
      }

      ForEach(this.modelRows, (row: RuntimeModelRow) => {
        this.CustomModelRow(row)
      }, (row: RuntimeModelRow) => `config-model-${row.id}-${this.rowRevision}`)

      RuntimeConfigAddButton({
        colors: this.colors,
        label: $r('app.string.runtime_config_custom_models_add'),
        fieldEnabled: this.fieldEnabled,
        onTap: () => {
          this.updateModelRows(this.modelRows.concat([new RuntimeModelRow()]));
        },
      })
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  CustomModelRow(row: RuntimeModelRow) {
    Column({ space: 10 }) {
      Row({ space: 8 }) {
        Text($r('app.string.runtime_config_custom_model'))
          .fontSize(14)
          .fontWeight(600)
          .fontColor(this.colors.ink)
          .layoutWeight(1)
        RuntimeConfigIconButton({
          colors: this.colors,
          commands: AA_ICONS.TRASH,
          danger: true,
          fieldEnabled: this.fieldEnabled,
          label: $r('app.string.runtime_config_custom_model_remove'),
          onTap: () => {
            this.updateModelRows(
              this.modelRows.filter((item: RuntimeModelRow) => item.id !== row.id),
            );
          },
        })
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      RuntimeConfigInput({
        colors: this.colors,
        value: row.modelId,
        placeholder: $r('app.string.runtime_config_model_id'),
        fieldEnabled: this.fieldEnabled,
        secure: false,
        onValueChange: (next: string) => {
          row.modelId = next;
          this.touchModelRows();
        },
      })
      RuntimeConfigInput({
        colors: this.colors,
        value: row.displayName,
        placeholder: $r('app.string.runtime_config_model_display_name'),
        fieldEnabled: this.fieldEnabled,
        secure: false,
        onValueChange: (next: string) => {
          row.displayName = next;
          this.touchModelRows();
        },
      })

      Row({ space: 8 }) {
        Text($r('app.string.runtime_config_efforts'))
          .fontSize(13)
          .fontWeight(600)
          .fontColor(this.colors.muted)
          .layoutWeight(1)
        RuntimeConfigIconButton({
          colors: this.colors,
          commands: AA_ICONS.PLUS,
          danger: false,
          fieldEnabled: this.fieldEnabled,
          label: $r('app.string.runtime_config_effort_add'),
          onTap: () => {
            row.efforts = row.efforts.concat([new RuntimeEffortRow()]);
            this.updateModelRows(this.modelRows);
          },
        })
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      if (row.efforts.length === 0) {
        Text($r('app.string.runtime_config_efforts_empty'))
          .fontSize(12)
          .fontColor(this.colors.muted)
          .width('100%')
      }

      ForEach(row.efforts, (effort: RuntimeEffortRow) => {
        Column({ space: 8 }) {
          Divider().strokeWidth(1).color(this.colors.border)
          Row({ space: 8 }) {
            Column() {
              RuntimeConfigInput({
                colors: this.colors,
                value: effort.effortId,
                placeholder: $r('app.string.runtime_config_effort_id'),
                fieldEnabled: this.fieldEnabled,
                secure: false,
                onValueChange: (next: string) => {
                  effort.effortId = next;
                  this.touchModelRows();
                },
              })
            }
            .layoutWeight(1)
            RuntimeConfigIconButton({
              colors: this.colors,
              commands: AA_ICONS.TRASH,
              danger: true,
              fieldEnabled: this.fieldEnabled,
              label: $r('app.string.runtime_config_effort_remove'),
              onTap: () => {
                row.efforts = row.efforts.filter((item: RuntimeEffortRow) => item.id !== effort.id);
                this.updateModelRows(this.modelRows);
              },
            })
          }
          .width('100%')
          .alignItems(VerticalAlign.Center)

          RuntimeConfigInput({
            colors: this.colors,
            value: effort.displayName,
            placeholder: $r('app.string.runtime_config_effort_name'),
            fieldEnabled: this.fieldEnabled,
            secure: false,
            onValueChange: (next: string) => {
              effort.displayName = next;
              this.touchModelRows();
            },
          })
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
      }, (effort: RuntimeEffortRow) => `config-effort-${effort.id}-${this.rowRevision}`)
    }
    .width('100%')
    .padding(10)
    .borderRadius(AARadius.CHIP)
    .backgroundColor(this.colors.raisedSurface)
    .border({ width: 1, color: this.colors.border })
    .alignItems(HorizontalAlign.Start)
  }
}

/**
 * The form's text field.
 *
 * Controlled, like every other input in this port: the editor holds the text and
 * this box renders it, so a rebuild can never drop a character. A secure field
 * gets iOS's reveal button.
 */
@Component
export struct RuntimeConfigInput {
  colors: AAColors = AA_LIGHT_COLORS;
  @Prop value: string = '';
  @Prop placeholder: ResourceStr = '';
  @Prop fieldEnabled: boolean = true;
  @Prop secure: boolean = false;
  onValueChange: (value: string) => void = () => {};

  @State private revealed: boolean = false;

  build() {
    Row({ space: 8 }) {
      TextInput({ text: this.value, placeholder: this.placeholder })
        .fontSize(14)
        .fontWeight(500)
        .fontColor(this.fieldEnabled ? this.colors.ink : withAlpha(this.colors.ink, 0.45))
        .placeholderColor(this.colors.faint)
        .placeholderFont({ size: 13 })
        .type(this.secure && !this.revealed ? InputType.Password : InputType.Normal)
        .backgroundColor('#00000000')
        .borderRadius(0)
        .padding(0)
        .layoutWeight(1)
        .enabled(this.fieldEnabled)
        .enterKeyType(EnterKeyType.Done)
        .onChange((next: string) => this.onValueChange(next))

      if (this.secure) {
        Column() {
          AAIcon({
            commands: this.revealed ? AA_ICONS.EYE_OFF : AA_ICONS.EYE,
            iconSize: 18,
            color: this.colors.muted,
          })
        }
        .width(32)
        .height(32)
        .justifyContent(FlexAlign.Center)
        .accessibilityText(this.revealed
          ? $r('app.string.runtime_config_hide_secret')
          : $r('app.string.runtime_config_show_secret'))
        .onClick(() => {
          this.revealed = !this.revealed;
        })
      }
    }
    .width('100%')
    .height(44)
    .padding({ left: 12, right: 12 })
    .borderRadius(AARadius.CHIP)
    .backgroundColor(this.colors.subtle)
    .border({ width: 1, color: this.colors.border })
    .alignItems(VerticalAlign.Center)
  }
}

/** A row's destructive or additive glyph, with a 44dp tap target. */
@Component
struct RuntimeConfigIconButton {
  colors: AAColors = AA_LIGHT_COLORS;
  commands: string = '';
  danger: boolean = false;
  @Prop fieldEnabled: boolean = true;
  label: Resource = $r('app.string.common_delete');
  onTap: () => void = () => {};

  build() {
    Column() {
      AAIcon({
        commands: this.commands,
        iconSize: 18,
        color: withAlpha(this.danger ? this.colors.errorText : this.colors.inkSoft,
          this.fieldEnabled ? 1 : 0.4),
      })
    }
    .width(44)
    .height(44)
    .borderRadius(22)
    .justifyContent(FlexAlign.Center)
    .accessibilityText(this.label)
    .onClick(() => {
      if (this.fieldEnabled) {
        this.onTap();
      }
    })
  }
}

/** iOS's `AppGlassButton`, content-width, for the two "add a row" actions. */
@Component
struct RuntimeConfigAddButton {
  colors: AAColors = AA_LIGHT_COLORS;
  label: ResourceStr = '';
  @Prop fieldEnabled: boolean = true;
  onTap: () => void = () => {};

  build() {
    Row({ space: 8 }) {
      AAIcon({ commands: AA_ICONS.PLUS, iconSize: 16, color: this.colors.ink })
      Text(this.label)
        .fontSize(AAFontSize.SMALL)
        .fontWeight(600)
        .fontColor(this.colors.ink)
        .maxLines(1)
    }
    .height(40)
    .padding({ left: 16, right: 18 })
    .borderRadius(20)
    .backgroundColor(this.colors.isDark ? '#1FFFFFFF' : '#14000000')
    .border({ width: 1, color: this.colors.border })
    .constraintSize({ minWidth: 44 })
    .alignItems(VerticalAlign.Center)
    .opacity(this.fieldEnabled ? 1 : 0.4)
    .onClick(() => {
      if (this.fieldEnabled) {
        this.onTap();
      }
    })
  }
}
