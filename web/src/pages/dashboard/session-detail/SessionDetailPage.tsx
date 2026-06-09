import { useCallback, useMemo, useState } from "react";
import { Icons } from "../../../components/Icons";
import { FilesPanel, type PickedFile } from "./runtime/FilesPanel";
import { FilePreviewPanel } from "./runtime/FilePreviewPanel";
import { RuntimeWindow } from "./runtime/RuntimeWindow";
import { TerminalPanel } from "./runtime/TerminalPanel";
import { RuntimePanel } from "./runtime/RuntimePanel";
import { useRuntimeLayout } from "./runtime/useRuntimeLayout";
import { makeRuntimeApi } from "./runtime/runtimeApi";
import "./runtime/runtime.css";

type Props = {
  sessionId: string;
  sessionTitle: string;
  token: string | null;
  onBack: () => void;
  // Demo mode bypasses the real API and serves mock data so the UI can
  // be exercised without a connector. Used by the demo entry point.
  demo?: boolean;
};

export function SessionDetailPage({ sessionId, sessionTitle, token, onBack, demo = false }: Props) {
  const [previewFile, setPreviewFile] = useState<PickedFile | null>(null);
  const [, setDirty] = useState(false);
  const [poppedRuntime, setPoppedRuntime] = useState({
    files: false,
    term: false,
    preview: false,
  });
  const layout = useRuntimeLayout();

  const api = useMemo(
    () => makeRuntimeApi({ sessionId, token, demo }),
    [sessionId, token, demo],
  );

  const onPickFile = useCallback((f: PickedFile) => {
    setPreviewFile(f);
    setPoppedRuntime((prev) => ({ ...prev, preview: true }));
  }, []);
  const onClosePreview = useCallback(() => setPreviewFile(null), []);

  const hasFiles = layout.panel === "files" || layout.panel === "both";
  const hasTerm = layout.panel === "term" || layout.panel === "both";
  const closePoppedFiles = useCallback(() => {
    setPoppedRuntime((prev) => ({ ...prev, files: false }));
    layout.setPanel(layout.panel === "both" ? "term" : "none");
  }, [layout]);
  const closePoppedTerm = useCallback(() => {
    setPoppedRuntime((prev) => ({ ...prev, term: false }));
    layout.setPanel(layout.panel === "both" ? "files" : "none");
  }, [layout]);
  const closePoppedPreview = useCallback(() => {
    setPoppedRuntime((prev) => ({ ...prev, preview: false }));
    setPreviewFile(null);
  }, []);
  const filesEl =
    hasFiles && !poppedRuntime.files ? (
      <FilesPanel
        api={api}
        onClose={() => layout.setPanel(layout.panel === "both" ? "term" : "none")}
        onPickFile={onPickFile}
        activeFile={previewFile}
        onPopOut={() => setPoppedRuntime((prev) => ({ ...prev, files: true }))}
      />
    ) : null;
  const previewEl =
    previewFile && !poppedRuntime.preview ? (
      <FilePreviewPanel
        api={api}
        file={previewFile}
        onClose={onClosePreview}
        onDirtyChange={setDirty}
        onPopOut={() =>
          setPoppedRuntime((prev) => ({ ...prev, preview: true }))
        }
      />
    ) : null;
  const termEl =
    hasTerm && !poppedRuntime.term ? (
      <TerminalPanel
        api={api}
        onClose={() => layout.setPanel(layout.panel === "both" ? "files" : "none")}
        title="Shell"
        onPopOut={() => setPoppedRuntime((prev) => ({ ...prev, term: true }))}
      />
    ) : null;

  return (
    <div className="kl-sd-root">
      <div className="kl-sd-main">
        <div className="kl-sd-hd">
          <button className="kl-sd-iconbtn" onClick={onBack} title="Back">
            <Icons.ChevRight size={15} style={{ transform: "rotate(180deg)" }} />
          </button>
          <div className="kl-sd-title">{sessionTitle}</div>
          <div className="kl-sd-acts">
            <button
              data-testid="toggle-files"
              className={"kl-sd-iconbtn" + (layout.panel !== "none" && layout.panel !== "term" ? " on" : "")}
              title="Toggle Files panel"
              onClick={layout.togglePanelFiles}
            >
              <Icons.Files size={15} />
            </button>
            <button
              data-testid="toggle-term"
              className={"kl-sd-iconbtn" + (layout.panel !== "none" && layout.panel !== "files" ? " on" : "")}
              title="Toggle Terminal panel"
              onClick={layout.togglePanelTerm}
            >
              <Icons.Terminal size={15} />
            </button>
          </div>
        </div>
        <div className="kl-sd-body">
          <p>这里是会话内容区。</p>
          <p>右侧的 Files / Terminal 是本次实现的两个面板 —
            点击右上角图标可以切换显示。</p>
          <p>试试：</p>
          <ul>
            <li>点 Files 图标 → 展开目录树，点文件看预览（可编辑、⌘F 文件内搜索、⌘S 保存）</li>
            <li>点 Terminal 图标 → 真实 PTY，多 tab，可 resize</li>
            <li>同时打开两者 + 预览 → 三栏布局；中间的拖拽条调宽度，水平条调高度</li>
          </ul>
        </div>
      </div>
      <RuntimePanel
        panel={layout.panel}
        setPanel={layout.setPanel}
        filesEl={filesEl}
        previewEl={previewEl}
        termEl={termEl}
        runtimeWidth={layout.runtimeWidth}
        setRuntimeWidth={layout.setRuntimeWidth}
        ratios={layout.ratios}
        setRatio={layout.setRatio}
      />
      {poppedRuntime.files && (
        <RuntimeWindow
          title={`${sessionTitle} - Files`}
          onClose={closePoppedFiles}
        >
          <FilesPanel
            api={api}
            onClose={closePoppedFiles}
            onPickFile={onPickFile}
            activeFile={previewFile}
            showClose
          />
        </RuntimeWindow>
      )}
      {poppedRuntime.term && (
        <RuntimeWindow
          title={`${sessionTitle} - Shell`}
          onClose={closePoppedTerm}
        >
          <TerminalPanel
            api={api}
            onClose={closePoppedTerm}
            title="Shell"
            showClose
          />
        </RuntimeWindow>
      )}
      {poppedRuntime.preview && previewFile && (
        <RuntimeWindow
          title={`${previewFile.name} - Preview`}
          onClose={closePoppedPreview}
        >
          <FilePreviewPanel
            api={api}
            file={previewFile}
            onClose={closePoppedPreview}
            onDirtyChange={setDirty}
          />
        </RuntimeWindow>
      )}
    </div>
  );
}
