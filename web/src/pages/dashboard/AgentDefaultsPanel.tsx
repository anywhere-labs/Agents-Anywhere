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

  const updateModels = (runtime: string, models: AgentCatalogEntry[]) => {
    setDraft((prev) => {
      if (!prev?.[runtime]) return prev;
      return {
        ...prev,
        [runtime]: {
          ...prev[runtime],
          models,
        },
      };
    });
  };

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
              models: toCatalogUpdate(item.models),
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
      <div className="aa-agent-defaults-toolbar">
        <div>
          <h3>Agent models</h3>
          <span>Configure available model IDs and the effort IDs each model supports.</span>
        </div>
        <button type="button" onClick={save} disabled={!dirty || saving}>
          {saving ? "Saving..." : "Save changes"}
        </button>
      </div>

      {error && <div className="aa-agent-defaults-error">{error}</div>}

      {RUNTIMES.map((runtime) => {
        const item = draft[runtime.key];
        if (!item) return null;
        return (
          <div className="aa-srv-card aa-agent-default-card" key={runtime.key}>
            <div className="hd">
              <h3>{runtime.label}</h3>
            </div>
            <div className="body aa-agent-defaults-body">
              <ModelCatalogEditor
                runtime={runtime.key}
                entries={item.models}
                onChange={(entries) => updateModels(runtime.key, entries)}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ModelCatalogEditor({
  runtime,
  entries,
  onChange,
}: {
  runtime: string;
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
        runtime,
        key: `custom-model-${next}`,
        displayLabel: `Custom model ${next}`,
        description: null,
        isDefault: false,
        sortOrder: next,
        efforts: [],
      },
    ]);
  };

  return (
    <div className="aa-agent-catalog">
      <div className="aa-agent-catalog-head">
        <span>Models</span>
        <button type="button" onClick={add}>
          <Icons.Plus size={13} />
          Add model
        </button>
      </div>
      <div className="aa-agent-catalog-list">
        {entries.map((entry, index) => (
          <div className="aa-agent-model-card" key={`${entry.key}-${index}`}>
            <div className="aa-agent-catalog-row aa-agent-model-row">
              <LabeledInput
                label="Model ID"
                value={entry.key}
                onChange={(value) => update(index, { key: value })}
              />
              <LabeledInput
                label="Display label"
                value={entry.displayLabel}
                onChange={(value) => update(index, { displayLabel: value })}
              />
              <button type="button" className="aa-agent-icon-btn" onClick={() => remove(index)}>
                <Icons.Trash size={13} />
              </button>
            </div>
            <EffortCatalogEditor
              runtime={runtime}
              model={entry}
              onChange={(efforts) => update(index, { efforts })}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function EffortCatalogEditor({
  runtime,
  model,
  onChange,
}: {
  runtime: string;
  model: AgentCatalogEntry;
  onChange: (entries: AgentCatalogEntry[]) => void;
}) {
  const efforts = model.efforts ?? [];
  const update = (index: number, patch: Partial<AgentCatalogEntry>) => {
    onChange(efforts.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));
  };
  const remove = (index: number) => {
    onChange(efforts.filter((_, i) => i !== index));
  };
  const add = () => {
    const next = efforts.length + 1;
    onChange([
      ...efforts,
      {
        runtime,
        key: `custom-effort-${next}`,
        displayLabel: `Custom effort ${next}`,
        description: null,
        isDefault: false,
        sortOrder: next,
        efforts: [],
      },
    ]);
  };

  return (
    <div className="aa-agent-efforts">
      <div className="aa-agent-efforts-head">
        <span>Efforts for {model.displayLabel || model.key}</span>
        <button type="button" onClick={add}>
          <Icons.Plus size={13} />
          Add effort
        </button>
      </div>
      {efforts.length === 0 ? (
        <div className="aa-agent-efforts-empty">No effort selector for this model.</div>
      ) : (
        <div className="aa-agent-efforts-list">
          {efforts.map((entry, index) => (
            <div className="aa-agent-catalog-row aa-agent-effort-row" key={`${entry.key}-${index}`}>
              <LabeledInput
                label="Effort ID"
                value={entry.key}
                onChange={(value) => update(index, { key: value })}
              />
              <LabeledInput
                label="Display label"
                value={entry.displayLabel}
                onChange={(value) => update(index, { displayLabel: value })}
              />
              <button type="button" className="aa-agent-icon-btn" onClick={() => remove(index)}>
                <Icons.Trash size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="aa-agent-inline-field">
      <span>{label}</span>
      <input value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function toCatalogUpdate(entries: AgentCatalogEntry[]): AgentCatalogEntryUpdate[] {
  return entries.map((entry, index) => ({
    key: entry.key,
    displayLabel: entry.displayLabel,
    description: entry.description,
    sortOrder: entry.sortOrder || index + 1,
    efforts: toCatalogUpdate(entry.efforts ?? []),
  }));
}
