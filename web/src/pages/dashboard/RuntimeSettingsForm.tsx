import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { RuntimeConfigField, RuntimeConfigSchema } from "../../lib/api";
import { filterClaudeEffortField } from "../../lib/claudeRuntime";
import { Icons } from "../../components/Icons";
import "./RuntimeSettingsForm.css";

type SettingOption = {
  value: string;
  label: string;
  description?: string | null;
};

type Props = {
  runtime: string;
  schema: RuntimeConfigSchema | null | undefined;
  settings: Record<string, unknown> | null;
  scope: "device" | "session";
  disabled?: boolean;
  className?: string;
  onPatch: (settings: Record<string, unknown>) => void;
};

export function RuntimeSettingsForm({
  runtime,
  schema,
  settings,
  scope,
  disabled = false,
  className = "kl-runtime-settings-form",
  onPatch,
}: Props) {
  const fields = runtimeConfigFields(schema, settings, scope);

  if (!schema) {
    return <div className={className} />;
  }

  if (fields.length === 0) {
    return (
      <div className={className}>
        <div className="kl-runtime-settings-empty">No settings available.</div>
      </div>
    );
  }

  return (
    <div className={className}>
      {fields.map((field) => (
        <RuntimeSettingField
          key={field.key}
          runtime={runtime}
          field={field}
          settings={settings}
          scope={scope}
          disabled={disabled || !settings}
          onPatch={onPatch}
        />
      ))}
    </div>
  );
}

export function runtimeConfigFields(
  schema: RuntimeConfigSchema | null | undefined,
  settings: Record<string, unknown> | null,
  scope: "device" | "session",
): RuntimeConfigField[] {
  return (schema?.fields ?? [])
    .filter((field) => !field.hidden)
    .filter((field) => scope === "device" || field.allowSessionOverride)
    .filter((field) => fieldVisible(field, settings));
}

export function optionLabel(
  field: RuntimeConfigField | null | undefined,
  value: unknown,
  fallback: string,
): string {
  if (!field) return fallback;
  const key = typeof value === "string" ? value : "";
  return (
    field.options?.find((option) => String(option.value) === key)?.label ??
    field.options?.[0]?.label ??
    fallback
  );
}

function RuntimeSettingField({
  runtime,
  field,
  settings,
  scope,
  disabled,
  onPatch,
}: {
  runtime: string;
  field: RuntimeConfigField;
  settings: Record<string, unknown> | null;
  scope: "device" | "session";
  disabled: boolean;
  onPatch: (settings: Record<string, unknown>) => void;
}) {
  const resolvedField =
    runtime === "claude" && field.key === "effort"
      ? filterClaudeEffortField(runtime, field, settings?.model)
      : field;
  if (!resolvedField) return null;
  field = resolvedField;

  if (runtime === "claude" && scope === "device" && field.key === "runMode") {
    const runMode = stringSetting(settings?.runMode, "chat");
    return (
      <SettingRow label="Default run mode">
        <div className="kl-runtime-settings-segmented" role="group">
          {optionPairs(field).map((option) => (
            <button
              key={option.value}
              type="button"
              className={runMode === option.value ? "on" : ""}
              disabled={disabled}
              onClick={() => onPatch({ runMode: option.value })}
            >
              {option.label}
            </button>
          ))}
        </div>
      </SettingRow>
    );
  }

  if (field.type === "object") {
    return (
      <>
        {(field.fields ?? [])
          .filter((child) => !child.hidden)
          .filter((child) => scope === "device" || child.allowSessionOverride)
          .filter((child) => fieldVisible(child, objectSetting(settings?.[field.key])))
          .map((child) => (
            <RuntimeObjectChildField
              key={`${field.key}.${child.key}`}
              parent={field}
              field={child}
              settings={settings}
              disabled={disabled}
              onPatch={onPatch}
            />
          ))}
      </>
    );
  }

  if (field.type === "enum") {
    return (
      <SettingSelect
        label={fieldLabel(field, scope)}
        value={stringSetting(settings?.[field.key], "")}
        options={optionPairs(field)}
        disabled={disabled}
        onChange={(value) => onPatch({ [field.key]: value })}
      />
    );
  }

  if (field.type === "boolean") {
    return (
      <SettingRow label={fieldLabel(field, scope)}>
        <SettingCheckbox
          checked={settings?.[field.key] === true}
          disabled={disabled}
          onChange={(checked) => onPatch({ [field.key]: checked })}
        />
      </SettingRow>
    );
  }

  return (
    <SettingRow label={fieldLabel(field, scope)}>
      <input
        className="kl-runtime-settings-input"
        value={stringSetting(settings?.[field.key], "")}
        disabled={disabled}
        onChange={(event) => onPatch({ [field.key]: event.target.value || null })}
      />
    </SettingRow>
  );
}

function RuntimeObjectChildField({
  parent,
  field,
  settings,
  disabled,
  onPatch,
}: {
  parent: RuntimeConfigField;
  field: RuntimeConfigField;
  settings: Record<string, unknown> | null;
  disabled: boolean;
  onPatch: (settings: Record<string, unknown>) => void;
}) {
  const parentSettings = objectSetting(settings?.[parent.key]) ?? {};
  const patchChild = (value: unknown) =>
    onPatch({
      [parent.key]: {
        ...parentSettings,
        [field.key]: value,
      },
    });

  if (field.type === "enum") {
    return (
      <SettingSelect
        label={parent.key === "sandboxPolicy" && field.key === "type" ? parent.label : field.label}
        value={stringSetting(parentSettings[field.key], "")}
        options={optionPairs(field)}
        disabled={disabled}
        onChange={(value) => patchChild(value || null)}
      />
    );
  }

  if (field.type === "boolean") {
    if (
      parent.key === "sandboxPolicy" &&
      field.key === "networkAccess" &&
      parentSettings.type === "dangerFullAccess"
    ) {
      return null;
    }
    return (
      <SettingRow label={field.label}>
        <SettingCheckbox
          checked={parentSettings[field.key] === true}
          disabled={disabled}
          onChange={patchChild}
        />
      </SettingRow>
    );
  }

  return null;
}

function SettingRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="kl-runtime-settings-row">
      <span className="kl-runtime-settings-label">{label}</span>
      {children}
    </label>
  );
}

function SettingSelect({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly SettingOption[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const effectiveValue = value || options[0]?.value || "";
  const selectedLabel =
    options.find((option) => option.value === effectiveValue)?.label ?? "Select";
  return (
    <SettingRow label={label}>
      <button
        type="button"
        className="kl-runtime-settings-selectbtn"
        disabled={disabled || options.length === 0}
        onClick={(event) => setAnchor((prev) => (prev ? null : event.currentTarget))}
      >
        <span>{selectedLabel}</span>
        <Icons.ChevDown size={12} />
      </button>
      {anchor && (
        <SettingMenu
          anchor={anchor}
          options={options}
          value={effectiveValue}
          onChange={onChange}
          onClose={() => setAnchor(null)}
        />
      )}
    </SettingRow>
  );
}

function SettingMenu({
  anchor,
  options,
  value,
  onChange,
  onClose,
}: {
  anchor: HTMLElement;
  options: readonly SettingOption[];
  value: string;
  onChange: (value: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (
        ref.current &&
        !ref.current.contains(event.target as Node) &&
        !anchor.contains(event.target as Node)
      ) {
        onClose();
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchor, onClose]);

  const rect = anchor.getBoundingClientRect();
  const hasDescriptions = options.some((option) => option.description);
  const width = Math.max(hasDescriptions ? 360 : 220, rect.width);
  const top = rect.bottom + 6;
  const left = Math.min(window.innerWidth - width - 8, rect.left);
  return (
    <div
      ref={ref}
      className="kl-runtime-settings-menu"
      style={{ top, left, width } as CSSProperties}
    >
      {options.map((option) => (
        <button
          key={option.value || "default"}
          type="button"
          className={value === option.value ? "on" : ""}
          onClick={() => {
            onChange(option.value);
            onClose();
          }}
        >
          <span className="kl-runtime-settings-menu-copy">
            <span>{option.label}</span>
            {option.description && (
              <span className="kl-runtime-settings-menu-desc">
                {option.description}
              </span>
            )}
          </span>
          <Icons.Check size={12} />
        </button>
      ))}
    </div>
  );
}

function SettingCheckbox({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <span className="kl-runtime-settings-check">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>Allow</span>
    </span>
  );
}

function optionPairs(
  field: RuntimeConfigField,
): readonly SettingOption[] {
  return (field.options ?? []).map((option) => ({
    value: String(option.value),
    label: option.label,
    description: option.description,
  }));
}

function fieldLabel(field: RuntimeConfigField, scope: "device" | "session"): string {
  if (scope === "device") return `Default ${lowerFirst(field.label)}`;
  return field.label;
}

function lowerFirst(value: string): string {
  if (!value) return value;
  return value.slice(0, 1).toLowerCase() + value.slice(1);
}

function stringSetting(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function objectSetting(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function fieldVisible(
  field: RuntimeConfigField,
  settings: Record<string, unknown> | null,
): boolean {
  if (!field.visibleWhen) return true;
  for (const [key, expected] of Object.entries(field.visibleWhen)) {
    if (settings?.[key] !== expected) return false;
  }
  return true;
}
