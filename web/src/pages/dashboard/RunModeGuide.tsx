import type { ReactNode } from "react";
import { Icons } from "../../components/Icons";
import claudeChatPreview from "../../assets/claude-code-chat-preview.jpg";
import claudeTerminalPreview from "../../assets/claude-code-terminal-preview.jpg";
import "./RunModeGuide.css";

export type ClaudeRunMode = "chat" | "terminal";

export function RunModeGuide({
  value,
  disabled,
  title = "Claude Code run mode",
  subtitle = "Choose how Claude Code runs on this device.",
  showBack = true,
  showClose = true,
  showDone = true,
  doneLabel = "Done",
  onBack,
  onClose,
  onDone,
  onSelect,
}: {
  value: ClaudeRunMode;
  disabled: boolean;
  title?: string;
  subtitle?: string;
  showBack?: boolean;
  showClose?: boolean;
  showDone?: boolean;
  doneLabel?: string;
  onBack?: () => void;
  onClose?: () => void;
  onDone?: () => void;
  onSelect: (runMode: ClaudeRunMode) => void;
}) {
  return (
    <div className="kl-runmode-guide">
      <div className="kl-runtime-config-hd">
        <div>
          {showBack && onBack && (
            <button
              type="button"
              className="kl-runmode-back"
              onClick={onBack}
            >
              <Icons.ChevRight size={13} />
              Back
            </button>
          )}
          <h3>{title}</h3>
          <span>{subtitle}</span>
        </div>
        {showClose && onClose && (
          <button
            type="button"
            className="kl-runmode-close"
            onClick={onClose}
            aria-label="Close"
          >
            <Icons.X size={16} />
          </button>
        )}
      </div>
      <div className="kl-runmode-cards">
        <RunModeCard
          mode="chat"
          title="Chat Mode"
          subtitle="Based on Claude Code SDK"
          preview={<ChatModeMock />}
          selected={value === "chat"}
          disabled={disabled}
          onSelect={() => onSelect("chat")}
        >
          <p>
            Anthropic treats this separately from Pro and Max subscriptions, so
            it may be billed through API usage or your relay provider. Best for
            API users and relay API users.
          </p>
        </RunModeCard>
        <RunModeCard
          mode="terminal"
          title="Terminal Mode"
          subtitle="Based on native Claude Code CLI"
          preview={<TerminalModeMock />}
          selected={value === "terminal"}
          disabled={disabled}
          onSelect={() => onSelect("terminal")}
        >
          <p>
            Runs the real Claude Code terminal on your device. Uses your local
            Claude Code login. Best for Pro and Max subscribers.
          </p>
        </RunModeCard>
      </div>
      {showDone && onDone && (
        <div className="kl-modal-actions">
          <button type="button" className="kl-btn ghost" onClick={onDone}>
            {doneLabel}
          </button>
        </div>
      )}
    </div>
  );
}

function RunModeCard({
  mode,
  title,
  subtitle,
  preview,
  selected,
  disabled,
  children,
  onSelect,
}: {
  mode: ClaudeRunMode;
  title: string;
  subtitle: string;
  preview: ReactNode;
  selected: boolean;
  disabled: boolean;
  children: ReactNode;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`kl-runmode-card ${mode}${selected ? " on" : ""}`}
      disabled={disabled}
      onClick={onSelect}
    >
      <span className="kl-runmode-card-head">
        <span>
          <strong>{title}</strong>
        </span>
        <span className="kl-runmode-radio" />
      </span>
      {preview}
      <span className="kl-runmode-card-subtitle">{subtitle}</span>
      {children}
    </button>
  );
}

function ChatModeMock() {
  return (
    <span className="kl-runmode-mock chat image" aria-hidden="true">
      <img src={claudeChatPreview} alt="" />
    </span>
  );
}

function TerminalModeMock() {
  return (
    <span className="kl-runmode-mock terminal image" aria-hidden="true">
      <img src={claudeTerminalPreview} alt="" />
    </span>
  );
}
