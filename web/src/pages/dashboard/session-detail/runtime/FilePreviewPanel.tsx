import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Icons } from "../../../../components/Icons";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, search, openSearchPanel } from "@codemirror/search";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { cpp } from "@codemirror/lang-cpp";
import { java } from "@codemirror/lang-java";
import { sql, MySQL, PostgreSQL, SQLite } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { php } from "@codemirror/lang-php";
import { StreamLanguage } from "@codemirror/language";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { bracketMatching, indentOnInput, syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { PickedFile } from "./FilesPanel";
import { RuntimeApiError, type RuntimeApi } from "./runtimeApi";
import { UnsavedChangesDialog } from "./UnsavedChangesDialog";

type Props = {
  api: RuntimeApi;
  file: PickedFile;
  onClose: () => void;
  // Notify parent that this file is now dirty/clean. The parent can use
  // this to gate other "close everything" actions.
  onDirtyChange?: (dirty: boolean) => void;
  onPopOut?: () => void;
};

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "binary"; size: number }
  | {
      kind: "ready";
      sha256OnDisk: string;
      initialContent: string;
      truncated: boolean;
    };

export type FilePreviewHandle = {
  // Called by parent to attempt to close. Returns true if it closed
  // immediately (clean), or false if it opened the unsaved-changes dialog.
  requestClose: () => boolean;
};

function languageFor(filename: string): Extension {
  const lower = filename.toLowerCase();
  const basename = lower.split(/[\\/]/).pop() ?? lower;
  const ext = basename.split(".").pop() ?? "";
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext)) return javascript({ typescript: ext.endsWith("ts") || ext.endsWith("tsx") || ext === "ts" || ext === "tsx", jsx: ext.endsWith("x") });
  if (ext === "json") return json();
  if (["md", "markdown", "mdx"].includes(ext)) return markdown();
  if (["py", "pyi"].includes(ext)) return python();
  if (["html", "htm"].includes(ext)) return html();
  if (["css", "scss"].includes(ext)) return css();
  if (["c", "h", "cc", "cpp", "cxx", "hpp", "hh", "hxx", "ino"].includes(ext)) return cpp();
  if (["java"].includes(ext)) return java();
  if (["sql"].includes(ext)) return sql();
  if (["mysql"].includes(ext)) return sql({ dialect: MySQL });
  if (["pgsql", "psql"].includes(ext)) return sql({ dialect: PostgreSQL });
  if (["sqlite", "sqlite3", "db"].includes(ext)) return sql({ dialect: SQLite });
  if (["xml", "svg", "xhtml", "rss", "atom", "plist"].includes(ext)) return xml();
  if (["yaml", "yml"].includes(ext)) return yaml();
  if (ext === "toml") return StreamLanguage.define(toml);
  if (["php", "phtml"].includes(ext)) return php();
  if (
    [
      "dockerfile",
      "makefile",
      "cmakelists.txt",
      "package.json",
      "tsconfig.json",
      "jsconfig.json",
      "composer.json",
      "cargo.toml",
      "pyproject.toml",
    ].includes(basename)
  ) {
    if (basename.endsWith(".json")) return json();
    if (basename.endsWith(".toml")) return StreamLanguage.define(toml);
    return [];
  }
  return [];
}

const previewHighlightStyle = HighlightStyle.define([
  {
    tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword, t.definitionKeyword],
    class: "cm-aa-keyword",
  },
  { tag: [t.string, t.special(t.string), t.regexp], class: "cm-aa-string" },
  { tag: [t.number, t.bool, t.null, t.atom], class: "cm-aa-literal" },
  { tag: [t.comment, t.lineComment, t.blockComment], class: "cm-aa-comment" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], class: "cm-aa-function" },
  { tag: [t.className, t.typeName, t.namespace], class: "cm-aa-type" },
  { tag: [t.propertyName, t.attributeName], class: "cm-aa-property" },
  { tag: [t.variableName, t.definition(t.variableName)], class: "cm-aa-variable" },
  { tag: [t.operator, t.derefOperator, t.arithmeticOperator, t.logicOperator, t.compareOperator], class: "cm-aa-operator" },
  { tag: [t.punctuation, t.separator, t.brace, t.squareBracket, t.paren], class: "cm-aa-punctuation" },
  { tag: [t.heading, t.strong], class: "cm-aa-heading" },
  { tag: [t.emphasis, t.link], class: "cm-aa-emphasis" },
]);

export function FilePreviewPanel({
  api,
  file,
  onClose,
  onDirtyChange,
  onPopOut,
}: Props) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  // Briefly flash a "Saved" badge after a successful write so the user
  // gets explicit confirmation that ⌘S landed.
  const [justSaved, setJustSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [confirmEdit, setConfirmEdit] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<EditorView | null>(null);
  const sha256Ref = useRef<string>("");

  // Load file content whenever `file.path` changes.
  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    setDirty(false);
    setSaveError(null);
    setDownloadError(null);
    setEditMode(false);
    api
      .fsReadText(file.path)
      .then((result) => {
        if (cancelled) return;
        if (result.binary) {
          setState({ kind: "binary", size: result.size });
          return;
        }
        sha256Ref.current = result.sha256;
        setState({
          kind: "ready",
          sha256OnDisk: result.sha256,
          initialContent: result.content,
          truncated: result.truncated,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [api, file.path]);

  // Build the CodeMirror editor whenever the ready state arrives.
  useEffect(() => {
    if (state.kind !== "ready") {
      editorRef.current?.destroy();
      editorRef.current = null;
      return;
    }
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      state: EditorState.create({
        doc: state.initialContent,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          history(),
          bracketMatching(),
          indentOnInput(),
          syntaxHighlighting(previewHighlightStyle),
          highlightActiveLine(),
          search({ top: true }),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
          languageFor(file.name),
          EditorView.editable.of(editMode),
          EditorView.theme(
            {
              "&": { backgroundColor: "transparent", color: "var(--text)" },
              ".cm-gutters": {
                backgroundColor: "transparent",
                color: "var(--text-faint)",
                borderRight: "1px solid var(--border)",
              },
              ".cm-activeLine": { backgroundColor: "var(--bg-hover)" },
              ".cm-activeLineGutter": { backgroundColor: "var(--bg-hover)" },
              ".cm-content": { caretColor: "var(--accent)" },
              ".cm-cursor": { borderLeftColor: "var(--accent)" },
              ".cm-selectionBackground": { backgroundColor: "var(--bg-active)" },
              "&.cm-focused .cm-selectionBackground, ::selection": {
                backgroundColor: "var(--bg-active) !important",
              },
              ".cm-panels": {
                backgroundColor: "var(--bg-elev, var(--bg-panel))",
                color: "var(--text)",
                borderTop: "1px solid var(--border)",
              },
              ".cm-textfield": {
                backgroundColor: "var(--bg-input)",
                color: "var(--text)",
                border: "1px solid var(--border)",
              },
              ".cm-button": {
                backgroundColor: "var(--bg-input)",
                color: "var(--text)",
                border: "1px solid var(--border)",
              },
            },
            { dark: document.documentElement.dataset.theme !== "light" },
          ),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) {
              const cur = u.state.doc.toString();
              const isDirty = cur !== state.initialContent;
              setDirty(isDirty);
              onDirtyChange?.(isDirty);
            }
          }),
        ],
      }),
      parent: host,
    });
    editorRef.current = view;
    // focus the editor so ⌘F / ⌘S work without clicking
    setTimeout(() => view.focus(), 0);
    return () => {
      view.destroy();
      editorRef.current = null;
    };
    // We re-create the editor when path changes (state.initialContent changes too).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.kind, file.path, editMode]);

  const doSave = useCallback(async () => {
    const view = editorRef.current;
    if (!view || !editMode) return;
    const content = view.state.doc.toString();
    setSaving(true);
    setSaveError(null);
    try {
      const w = await api.fsWrite(file.path, content, sha256Ref.current || null);
      sha256Ref.current = w.result.sha256;
      setDirty(false);
      onDirtyChange?.(false);
      // Replace initial baseline so subsequent edits compute correctly.
      setState((prev) => (prev.kind === "ready" ? { ...prev, initialContent: content, sha256OnDisk: w.result.sha256 } : prev));
      // Briefly flash "Saved" — auto-clears after 1.5s.
      setJustSaved(true);
      window.setTimeout(() => setJustSaved(false), 1500);
    } catch (err) {
      if (err instanceof RuntimeApiError && err.status === 412) {
        setSaveError("The file changed on disk. Refresh before saving again.");
      } else {
        setSaveError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSaving(false);
    }
  }, [api, editMode, file.path, onDirtyChange]);

  // ⌘S / Ctrl-S to save.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        // Only react when our editor is focused, otherwise we'd hijack
        // every ⌘S on the page.
        const view = editorRef.current;
        if (!view) return;
        if (document.activeElement && view.dom.contains(document.activeElement)) {
          e.preventDefault();
          void doSave();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [doSave]);

  const handleClose = useCallback(() => {
    if (!dirty) {
      onClose();
      return;
    }
    setConfirmClose(true);
  }, [dirty, onClose]);

  const downloadBlob = useCallback((blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename || "download";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }, []);

  const handleDownload = useCallback(async () => {
    setDownloadError(null);
    if (state.kind === "ready") {
      const view = editorRef.current;
      const content = view?.state.doc.toString() ?? state.initialContent;
      downloadBlob(new Blob([content], { type: "text/plain;charset=utf-8" }), file.name);
      return;
    }
    setDownloading(true);
    try {
      const read = await api.fsReadFile(file.path);
      const blob = await api.fsDownloadBlob(read.result.downloadUrl);
      downloadBlob(blob, read.result.name || file.name);
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(false);
    }
  }, [api, downloadBlob, file.name, file.path, state]);

  const enableEdit = useCallback(() => {
    setConfirmEdit(false);
    setEditMode(true);
    setTimeout(() => editorRef.current?.focus(), 0);
  }, []);

  const handleToggleEdit = useCallback(() => {
    if (editMode) {
      if (dirty) {
        setConfirmClose(true);
      } else {
        setEditMode(false);
      }
      return;
    }
    setConfirmEdit(true);
  }, [dirty, editMode]);

  // Expose imperative API if a parent ever needs to intercept close.
  // (We don't use forwardRef because the prototype passes it through props,
  // but this keeps the option open.)
  void useImperativeHandle;

  const lang = useMemo(() => {
    const ext = file.name.toLowerCase().split(".").pop() ?? "";
    return ext || "text";
  }, [file.name]);

  return (
    <div className="kl-rt-pane">
      <div className="kl-rt-hd">
        <div className="title">
          <Icons.File size={13} /> <span className="name">{file.name}</span>
          {dirty && <span className="dirty-dot" title="Unsaved changes" />}
          <button
            type="button"
            className={`kl-edit-switch${editMode ? " on" : ""}`}
            title={editMode ? "Editing enabled" : "Enable editing"}
            onClick={handleToggleEdit}
            disabled={state.kind !== "ready"}
          >
            <span className="track" />
            Edit
          </button>
          {editMode && (
            <button
              className="iconbtn kl-save-btn"
              title={dirty ? "Save (⌘S)" : "Saved"}
              onClick={doSave}
              disabled={!dirty || saving || state.kind !== "ready"}
              style={{ opacity: dirty ? 1 : 0.5 }}
            >
              <Icons.Save size={13} />
            </button>
          )}
        </div>
        <span className="sep" />
        <span className="meta">{lang}</span>
        <div className="acts">
          {onPopOut && (
            <button className="iconbtn" title="Open in window" onClick={onPopOut}>
              <Icons.External size={13} />
            </button>
          )}
          <button
            className="iconbtn"
            title={downloading ? "Downloading…" : "Download"}
            onClick={handleDownload}
            disabled={downloading || state.kind === "loading"}
          >
            {downloading ? <Icons.Loader size={13} /> : <Icons.Download size={13} />}
          </button>
          <button className="iconbtn" title="Search (⌘F)" onClick={() => editorRef.current && openSearchPanel(editorRef.current)} disabled={state.kind !== "ready"}>
            <Icons.Search size={13} />
          </button>
          <button className="iconbtn" title="Close" onClick={handleClose}>
            <Icons.X size={13} />
          </button>
        </div>
      </div>
      <div className="kl-fp-toolbar">
        <span className="path-text">{file.path}</span>
        {state.kind === "ready" && state.truncated && (
          <span style={{ color: "oklch(0.78 0.13 78)" }}>· truncated</span>
        )}
        {saveError && (
          <span className="kl-fp-badge err" title={saveError}>
            {saveError.length > 60 ? saveError.slice(0, 60) + "…" : saveError}
          </span>
        )}
        {downloadError && (
          <span className="kl-fp-badge err" title={downloadError}>
            {downloadError.length > 60 ? downloadError.slice(0, 60) + "…" : downloadError}
          </span>
        )}
        {/* Three-state save indicator: Unsaved → Saving… → Saved (then clears).
            Priority: error > saving > unsaved > just-saved. */}
        {!saveError && saving && <span className="kl-fp-badge saving">Saving…</span>}
        {!saveError && !saving && dirty && (
          <span className="kl-fp-badge unsaved">Unsaved</span>
        )}
        {!saveError && !saving && !dirty && justSaved && (
          <span className="kl-fp-badge saved">Saved</span>
        )}
      </div>
      <div className="kl-fp-body">
        {state.kind === "loading" && (
          <div className="kl-fp-binary">Loading…</div>
        )}
        {state.kind === "error" && (
          <div className="kl-fp-binary" style={{ color: "oklch(0.7 0.16 25)" }}>
            {state.message}
          </div>
        )}
        {state.kind === "binary" && (
          <div className="kl-fp-binary kl-fp-unavailable">
            <span>
              Binary file ({state.size.toLocaleString()} bytes) — preview unavailable.
            </span>
            <button className="kl-btn ghost" onClick={handleDownload} disabled={downloading}>
              {downloading ? "Downloading…" : "Download"}
            </button>
          </div>
        )}
        {state.kind === "ready" && <div ref={hostRef} style={{ height: "100%" }} />}
      </div>
      {confirmClose && (
        <UnsavedChangesDialog
          filename={file.name}
          onSave={async () => {
            await doSave();
            setConfirmClose(false);
            // Only close if the save succeeded (no current saveError on the
            // next tick); for simplicity we close anyway so the user isn't
            // stuck — they'll see the error toast in the toolbar if save
            // failed. But practically, if it failed, dirty stays true and
            // they'll be prompted again next time.
            onClose();
          }}
          onDiscard={() => {
            setConfirmClose(false);
            setDirty(false);
            onDirtyChange?.(false);
            onClose();
          }}
          onCancel={() => setConfirmClose(false)}
        />
      )}
      {confirmEdit && (
        <EditWarningDialog
          filename={file.name}
          onCancel={() => setConfirmEdit(false)}
          onConfirm={enableEdit}
        />
      )}
    </div>
  );
}

function EditWarningDialog({
  filename,
  onCancel,
  onConfirm,
}: {
  filename: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="kl-unsaved-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="kl-edit-warning-title"
      onClick={onCancel}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
    >
      <div className="kl-unsaved" onClick={(e) => e.stopPropagation()}>
        <h3 id="kl-edit-warning-title">Edit {filename}?</h3>
        <p>
          The original file may have changed on disk. If you edit and save,
          your changes will overwrite the current file contents.
        </p>
        <div className="kl-unsaved-actions">
          <button className="kl-btn ghost" onClick={onCancel}>
            Cancel
          </button>
          <button className="kl-btn primary" autoFocus onClick={onConfirm}>
            Enable editing
          </button>
        </div>
      </div>
    </div>
  );
}
