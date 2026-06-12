import { useEffect, useMemo, useState } from "react";
import { Icons } from "../../components/Icons";
import {
  api,
  ApiError,
  type AgentCatalogEntry,
  type AgentCatalogEntryUpdate,
  type UserAgentDefaultRuntime,
  type UserAgentDefaultsResponse,
} from "../../lib/api";

type Props = {
  token: string;
};

type Draft = Record<string, UserAgentDefaultRuntime>;

const RUNTIMES = [
  { key: "codex", label: "Codex" },
  { key: "claude", label: "Claude" },
] as const;

const CODEX_PERMISSION_OPTIONS = [
  { value: "ask", label: "Ask for approval" },
  { value: "auto", label: "Approve for me" },
  { value: "fullAccess", label: "Full access" },
];

const CLAUDE_PERMISSION_OPTIONS = [
  { value: "default", label: "Ask permissions" },
  { value: "acceptEdits", label: "Accept edits" },
  { value: "plan", label: "Plan mode" },
  { value: "bypassPermissions", label: "Bypass permissions" },
];

const CLAUDE_RUN_MODE_OPTIONS = [
  { value: "chat", label: "Chat" },
  { value: "terminal", label: "Terminal" },
];

export function AgentDefaultsPanel({ token }: Props) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [serverDraft, setServerDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    setError(null);
    api
      .getAgentDefaults(token)
      .then((res) => {
        if (!alive) return;
        setDraft(res.runtimes);
        setServerDraft(res.runtimes);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setError(err instanceof ApiError ? err.message : "Failed to load agent settings.");
      });
    return () => {
      alive = false;
    };
  }, [token]);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(serverDraft),
    [draft, serverDraft],
  );

  const updateRuntime = (
    runtime: string,
    patch: Partial<UserAgentDefaultRuntime>,
  ) => {
    setDraft((prev) => {
      if (!prev?.[runtime]) return prev;
      return {
        ...prev,
        [runtime]: {
          ...prev[runtime],
          ...patch,
          settings: patch.settings
            ? { ...prev[runtime].settings, ...patch.settings }
            : prev[runtime].settings,
        },
      };
    });
  };

  const updateCatalog = (
    runtime: string,
    kind: "models" | "efforts",
    entries: AgentCatalogEntry[],
  ) => updateRuntime(runtime, { [kind]: normalizeDefaultEntry(entries) });

  const save = async () => {
    if (!draft || saving) return;
    setSaving(true);
    setError(null);
    try {
      const payload = {
        runtimes: Object.fromEntries(
          Object.entries(draft).map(([runtime, item]) => [
            runtime,
            {
              enabled: item.enabled,
              settings: item.settings,
              models: toCatalogUpdate(item.models),
              efforts: toCatalogUpdate(item.efforts),
            },
          ]),
        ),
      };
      const res: UserAgentDefaultsResponse = await api.patchAgentDefaults(token, payload);
      setDraft(res.runtimes);
      setServerDraft(res.runtimes);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save agent settings.");
    } finally {
      setSaving(false);
    }
  };

  if (!draft) {
    return (
      <div className="aa-srv-card">
        <div className="hd">
          <h3>Agent settings</h3>
        </div>
        <div className="body aa-agent-defaults-body">
          <div className="aa-agent-defaults-empty">
            {error ?? "Loading agent settings..."}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="aa-settings-stack">
      {RUNTIMES.map((runtime) => {
        const item = draft[runtime.key];
        if (!item) return null;
        return (
          <div className="aa-srv-card aa-agent-default-card" key={runtime.key}>
            <div className="hd">
              <h3>{runtime.label}</h3>
              <label className="aa-srv-switch aa-agent-runtime-switch">
                <input
                  type="checkbox"
                  checked={item.enabled}
                  onChange={(event) =>
                    updateRuntime(runtime.key, { enabled: event.target.checked })
                  }
                />
                <span className="track" />
                <span className="knob" />
              </label>
            </div>
            <div className="body aa-agent-defaults-body">
              {runtime.key === "claude" && (
                <AgentSelect
                  label="Default run mode"
                  value={stringSetting(item.settings.runMode, "chat")}
                  options={CLAUDE_RUN_MODE_OPTIONS}
                  onChange={(value) =>
                    updateRuntime(runtime.key, { settings: { runMode: value } })
                  }
                />
              )}
              <AgentSelect
                label="Permission mode"
                value={stringSetting(
                  item.settings.permissionMode,
                  runtime.key === "codex" ? "ask" : "acceptEdits",
                )}
                options={
                  runtime.key === "codex"
                    ? CODEX_PERMISSION_OPTIONS
                    : CLAUDE_PERMISSION_OPTIONS
                }
                onChange={(value) =>
                  updateRuntime(runtime.key, { settings: { permissionMode: value } })
                }
              />
              <AgentSelect
                label="Default model"
                value={stringSetting(item.settings.model, item.models[0]?.key ?? "")}
                options={item.models.map((entry) => ({
                  value: entry.key,
                  label: entry.displayLabel,
                }))}
                onChange={(value) =>
                  updateRuntime(runtime.key, { settings: { model: value || null } })
                }
              />
              <AgentSelect
                label="Effort"
                value={stringSetting(item.settings.effort, item.efforts[0]?.key ?? "")}
                options={item.efforts.map((entry) => ({
                  value: entry.key,
                  label: entry.displayLabel,
                }))}
                onChange={(value) =>
                  updateRuntime(runtime.key, { settings: { effort: value || null } })
                }
              />
              <CatalogEditor
                title="Models"
                entries={item.models}
                onChange={(entries) => updateCatalog(runtime.key, "models", entries)}
              />
              <CatalogEditor
                title="Efforts"
                entries={item.efforts}
                onChange={(entries) => updateCatalog(runtime.key, "efforts", entries)}
              />
            </div>
          </div>
        );
      })}

      <div className="aa-agent-defaults-actions">
        {error && <span className="aa-agent-defaults-error">{error}</span>}
        <button type="button" onClick={save} disabled={!dirty || saving}>
          {saving ? "Saving..." : "Save changes"}
        </button>
      </div>
    </div>
  );
}

function AgentSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="aa-agent-field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function CatalogEditor({
  title,
  entries,
  onChange,
}: {
  title: string;
  entries: AgentCatalogEntry[];
  onChange: (entries: AgentCatalogEntry[]) => void;
}) {
  const update = (index: number, patch: Partial<AgentCatalogEntry>) => {
    onChange(entries.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));
  };
  const remove = (index: number) => {
    onChange(entries.filter((_, i) => i !== index));
  };
  const add = () => {
    const next = entries.length + 1;
    onChange([
      ...entries,
      {
        runtime: entries[0]?.runtime ?? "codex",
        key: `custom-${next}`,
        displayLabel: `Custom ${next}`,
        description: null,
        isDefault: entries.length === 0,
        sortOrder: next,
      },
    ]);
  };

  return (
    <div className="aa-agent-catalog">
      <div className="aa-agent-catalog-head">
        <span>{title}</span>
        <button type="button" onClick={add}>
          <Icons.Plus size={13} />
          Add
        </button>
      </div>
      <div className="aa-agent-catalog-list">
        {entries.map((entry, index) => (
          <div className="aa-agent-catalog-row" key={`${entry.key}-${index}`}>
            <input
              value={entry.key}
              aria-label={`${title} key`}
              onChange={(event) => update(index, { key: event.target.value })}
            />
            <input
              value={entry.displayLabel}
              aria-label={`${title} label`}
              onChange={(event) =>
                update(index, { displayLabel: event.target.value })
              }
            />
            <label className="aa-agent-default-radio">
              <input
                type="radio"
                checked={entry.isDefault}
                onChange={() =>
                  onChange(entries.map((item, i) => ({ ...item, isDefault: i === index })))
                }
              />
              Default
            </label>
            <button type="button" className="aa-agent-icon-btn" onClick={() => remove(index)}>
              <Icons.Trash size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function normalizeDefaultEntry(entries: AgentCatalogEntry[]): AgentCatalogEntry[] {
  if (entries.length === 0) return entries;
  if (entries.some((entry) => entry.isDefault)) return entries;
  return entries.map((entry, index) => ({ ...entry, isDefault: index === 0 }));
}

function toCatalogUpdate(entries: AgentCatalogEntry[]): AgentCatalogEntryUpdate[] {
  return entries.map((entry, index) => ({
    key: entry.key,
    displayLabel: entry.displayLabel,
    description: entry.description,
    isDefault: entry.isDefault,
    sortOrder: entry.sortOrder || index + 1,
  }));
}

function stringSetting(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}
