import { useCallback, useEffect, useState } from "react";
import { Icons } from "../../components/Icons";
import {
  ApiError,
  api,
  type InstanceSettings,
  type ServiceInfo,
} from "../../lib/api";

type ServicePageProps = {
  token: string;
  onBack: () => void;
};

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rem = minutes % 60;
    return rem ? `${hours}h ${rem}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours ? `${days}d ${remHours}h` : `${days}d`;
}

export function ServicePage({ token, onBack }: ServicePageProps) {
  const [info, setInfo] = useState<ServiceInfo | null>(null);
  const [settings, setSettings] = useState<InstanceSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [togglePending, setTogglePending] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const publicUrl = browserPublicUrl();

  const refresh = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const [svc, settingsBody] = await Promise.all([
        api.getServiceInfo(token),
        api.getSettings(token),
      ]);
      setInfo(svc);
      setSettings(settingsBody);
    } catch (err) {
      if (err instanceof ApiError) setError(err.detail);
      else setError("Failed to load service info.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleToggle = async (
    key: "registrationOpen" | "oauthRegistrationOpen",
    next: boolean,
  ) => {
    if (togglePending) return;
    setTogglePending(true);
    try {
      const updated = await api.updateSettings(token, { [key]: next });
      setSettings(updated);
    } catch (err) {
      if (err instanceof ApiError) setError(err.detail);
    } finally {
      setTogglePending(false);
    }
  };

  const copy = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      window.setTimeout(() => setCopied(null), 1200);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="aa-srv" data-screen-label="05 Service">
      <div className="aa-srv-body">
        <button type="button" className="aa-srv-back-fixed" onClick={onBack}>
          <Icons.ChevRight size={14} style={{ transform: "rotate(180deg)" }} />
          Back
        </button>

        <div className="aa-srv-inner">
          <div className="aa-srv-h">
            <h1>Service</h1>
            <p>Configuration and runtime info for this instance.</p>
          </div>

          {loading && (
            <div className="aa-srv-card">
              <div className="body" style={{ padding: 24, color: "var(--text-mut)" }}>
                Loading…
              </div>
            </div>
          )}

          {error && (
            <div className="aa-srv-card">
              <div className="body" style={{ padding: 24, color: "oklch(0.72 0.13 25)" }}>
                {error}
              </div>
            </div>
          )}

          {info && (
            <div className="aa-srv-card">
              <div className="hd">
                <h3>Server</h3>
              </div>
              <div className="body">
                <div className="aa-srv-row">
                  <span className="k">Endpoint</span>
                  <span className="v">
                    <code>{publicUrl}</code>
                  </span>
                  <button
                    type="button"
                    className="copy"
                    onClick={() => copy("url", publicUrl)}
                    aria-label="Copy URL"
                  >
                    {copied === "url" ? <Icons.Check size={12} /> : <Icons.Copy size={12} />}
                  </button>
                </div>
                <div className="aa-srv-row">
                  <span className="k">Version</span>
                  <span className="v">{info.version}</span>
                  <span />
                </div>
                <div className="aa-srv-row">
                  <span className="k">Database</span>
                  <span className="v">
                    <span className="badge">{info.database}</span>
                    {info.databasePath && (
                      <code style={{ color: "var(--text-mut)", fontSize: "var(--fs-sm)" }}>
                        {info.databasePath}
                      </code>
                    )}
                  </span>
                  {info.databasePath && (
                    <button
                      type="button"
                      className="copy"
                      onClick={() => copy("db", info.databasePath ?? "")}
                      aria-label="Copy DB path"
                    >
                      {copied === "db" ? <Icons.Check size={12} /> : <Icons.Copy size={12} />}
                    </button>
                  )}
                </div>
                <div className="aa-srv-row">
                  <span className="k">Uptime</span>
                  <span className="v" style={{ color: "var(--text-mid)" }}>
                    {formatUptime(info.uptimeSeconds)}
                  </span>
                  <span />
                </div>
              </div>
            </div>
          )}

          {settings && (
            <div className="aa-srv-card">
              <div className="hd">
                <h3>Access</h3>
              </div>
              <div className="body">
                <div className="aa-srv-toggle">
                  <div className="info">
                    <span className="t">Open registration</span>
                    <span className="s">
                      When enabled, anyone reaching the sign-in page can create their
                      own account. When disabled, only admins can add users from the
                      Team page.
                    </span>
                  </div>
                  <label className="aa-srv-switch">
                    <input
                      type="checkbox"
                      checked={settings.registrationOpen}
                      disabled={togglePending}
                      onChange={(e) => handleToggle("registrationOpen", e.target.checked)}
                    />
                    <span className="track" />
                    <span className="knob" />
                  </label>
                </div>
                <div className="aa-srv-toggle">
                  <div className="info">
                    <span className="t">OAuth registration</span>
                    <span className="s">
                      When enabled, a new OAuth identity can create a local account.
                      Existing linked OAuth accounts can still sign in when disabled.
                    </span>
                  </div>
                  <label className="aa-srv-switch">
                    <input
                      type="checkbox"
                      checked={settings.oauthRegistrationOpen}
                      disabled={togglePending}
                      onChange={(e) => handleToggle("oauthRegistrationOpen", e.target.checked)}
                    />
                    <span className="track" />
                    <span className="knob" />
                  </label>
                </div>
              </div>
            </div>
          )}

          <div className="aa-srv-card">
            <div className="hd">
              <h3>First-party Clients</h3>
            </div>
            <div className="body">
              <div className="aa-srv-toggle">
                <div className="info">
                  <span className="t">Mobile OAuth callback</span>
                  <span className="s">
                    Built-in clients use the fixed custom scheme callback. Generic
                    OAuth client configuration is intentionally not exposed.
                  </span>
                </div>
                <span className="aa-srv-count">locked</span>
              </div>
              <div className="aa-srv-row">
                <span className="k">Client ID</span>
                <span className="v">
                  <code>agents-anywhere-mobile</code>
                </span>
                <span />
              </div>
              <div className="aa-srv-row">
                <span className="k">Callback</span>
                <span className="v">
                  <code>agents-anywhere://oauth/callback</code>
                </span>
                <button type="button" className="copy" onClick={() => copy("first-party-callback", "agents-anywhere://oauth/callback")} aria-label="Copy callback">
                  {copied === "first-party-callback" ? <Icons.Check size={12} /> : <Icons.Copy size={12} />}
                </button>
              </div>
            </div>
          </div>

          <div className="aa-srv-card">
            <div className="hd">
              <h3>About</h3>
            </div>
            <div className="aa-srv-about">
              <p>
                <span className="aa-word">
                  Agents Anywhere
                </span>{" "}
                is an open-source remote control surface for your AI coding agents.
                Self-host it, fork it, contribute back.
              </p>
              <div className="links">
                <a
                  className="aa-srv-link"
                  href="https://github.com/anywhere-labs/Agents-Anywhere"
                  target="_blank"
                  rel="noreferrer"
                >
                  <Icons.GitHub size={13} /> View on GitHub
                </a>
                <a
                  className="aa-srv-link"
                  href="#"
                  onClick={(e) => e.preventDefault()}
                >
                  <Icons.Globe size={13} /> Documentation
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function browserPublicUrl(): string {
  return window.location.origin.replace(/\/$/, "");
}
