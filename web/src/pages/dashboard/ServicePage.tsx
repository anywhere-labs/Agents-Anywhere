import { useCallback, useEffect, useState } from "react";
import { Icons } from "../../components/Icons";
import {
  ApiError,
  api,
  type InstanceSettings,
  type OAuthClient,
  type OAuthProviderConfig,
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
  const [oauthClients, setOauthClients] = useState<OAuthClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [togglePending, setTogglePending] = useState(false);
  const [oauthPending, setOauthPending] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [oauthForm, setOauthForm] = useState<OAuthProviderConfig & { clientSecret: string }>(
    defaultOAuthForm(),
  );
  const [clientName, setClientName] = useState("");
  const [clientRedirectUris, setClientRedirectUris] = useState("");
  const externalOAuthRedirectUrl = info ? `${info.endpoint}/auth/oauth/callback` : "";

  const refresh = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const [svc, settingsBody] = await Promise.all([
        api.getServiceInfo(token),
        api.getSettings(token),
      ]);
      const clients = await api.listOAuthClients(token);
      setInfo(svc);
      setSettings(settingsBody);
      setOauthClients(clients.clients);
      setOauthForm({ ...defaultOAuthForm(), ...(settingsBody.oauth ?? {}), clientSecret: "" });
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

  const saveOAuthProvider = async () => {
    if (oauthPending) return;
    setOauthPending(true);
    setError(null);
    try {
      const updated = await api.updateSettings(token, {
        oauth: {
          ...oauthForm,
          clientSecret: oauthForm.clientSecret || undefined,
        },
      });
      setSettings(updated);
      setOauthForm({ ...defaultOAuthForm(), ...(updated.oauth ?? {}), clientSecret: "" });
    } catch (err) {
      if (err instanceof ApiError) setError(err.detail);
      else setError("Failed to save OAuth provider.");
    } finally {
      setOauthPending(false);
    }
  };

  const createClient = async () => {
    const redirects = clientRedirectUris
      .split(/\s+/)
      .map((value) => value.trim())
      .filter(Boolean);
    if (!clientName.trim() || redirects.length === 0) return;
    setOauthPending(true);
    setError(null);
    try {
      const created = await api.createOAuthClient(token, {
        name: clientName.trim(),
        redirectUris: redirects,
      });
      setOauthClients((prev) => [...prev, created]);
      setClientName("");
      setClientRedirectUris("");
    } catch (err) {
      if (err instanceof ApiError) setError(err.detail);
      else setError("Failed to create OAuth client.");
    } finally {
      setOauthPending(false);
    }
  };

  const deleteClient = async (clientId: string) => {
    setOauthPending(true);
    setError(null);
    try {
      await api.deleteOAuthClient(token, clientId);
      setOauthClients((prev) => prev.filter((client) => client.clientId !== clientId));
    } catch (err) {
      if (err instanceof ApiError) setError(err.detail);
    } finally {
      setOauthPending(false);
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
                    <code>{info.endpoint}</code>
                  </span>
                  <button
                    type="button"
                    className="copy"
                    onClick={() => copy("url", info.endpoint)}
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

          {settings && (
            <div className="aa-srv-card">
              <div className="hd">
                <h3>External OAuth Login</h3>
              </div>
              <div className="body">
                <div className="aa-srv-toggle">
                  <div className="info">
                    <span className="t">External provider</span>
                    <span className="s">Use an upstream OAuth or OIDC provider for web sign-in.</span>
                  </div>
                  <label className="aa-srv-switch">
                    <input
                      type="checkbox"
                      checked={oauthForm.enabled}
                      onChange={(e) => setOauthForm((prev) => ({ ...prev, enabled: e.target.checked }))}
                    />
                    <span className="track" />
                    <span className="knob" />
                  </label>
                </div>
                <ServiceInput label="Provider" value={oauthForm.provider} onChange={(provider) => setOauthForm((prev) => ({ ...prev, provider }))} />
                <div className="aa-srv-row">
                  <span className="k">Redirect URL</span>
                  <span className="v">
                    <code>{externalOAuthRedirectUrl}</code>
                  </span>
                  <button
                    type="button"
                    className="copy"
                    onClick={() => copy("oauth-redirect", externalOAuthRedirectUrl)}
                    aria-label="Copy OAuth redirect URL"
                  >
                    {copied === "oauth-redirect" ? <Icons.Check size={12} /> : <Icons.Copy size={12} />}
                  </button>
                </div>
                <ServiceInput label="Button label" value={oauthForm.label} onChange={(label) => setOauthForm((prev) => ({ ...prev, label }))} />
                <ServiceInput label="Authorize URL" value={oauthForm.authorizeUrl} onChange={(authorizeUrl) => setOauthForm((prev) => ({ ...prev, authorizeUrl }))} />
                <ServiceInput label="Token URL" value={oauthForm.tokenUrl} onChange={(tokenUrl) => setOauthForm((prev) => ({ ...prev, tokenUrl }))} />
                <ServiceInput label="UserInfo URL" value={oauthForm.userInfoUrl} onChange={(userInfoUrl) => setOauthForm((prev) => ({ ...prev, userInfoUrl }))} />
                <ServiceInput label="Client ID" value={oauthForm.clientId} onChange={(clientId) => setOauthForm((prev) => ({ ...prev, clientId }))} />
                <ServiceInput label="Client secret" type="password" value={oauthForm.clientSecret} placeholder="Leave blank to keep existing" onChange={(clientSecret) => setOauthForm((prev) => ({ ...prev, clientSecret }))} />
                <ServiceInput label="Scopes" value={oauthForm.scopes} onChange={(scopes) => setOauthForm((prev) => ({ ...prev, scopes }))} />
                <ServiceInput label="Username claim" value={oauthForm.usernameClaim} onChange={(usernameClaim) => setOauthForm((prev) => ({ ...prev, usernameClaim }))} />
                <div className="aa-srv-row">
                  <span className="k">Status</span>
                  <span className="v">
                    <span className="badge">{oauthForm.enabled ? "enabled" : "disabled"}</span>
                  </span>
                  <button type="button" className="copy" disabled={oauthPending} onClick={saveOAuthProvider} aria-label="Save OAuth provider">
                    <Icons.Check size={13} />
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="aa-srv-card">
            <div className="hd">
              <h3>OAuth Clients</h3>
            </div>
            <div className="body">
              <div className="aa-srv-toggle">
                <div className="info">
                  <span className="t">Authorization server</span>
                  <span className="s">Native and desktop clients can use this server with authorization code + PKCE.</span>
                </div>
                <span className="aa-srv-count">{oauthClients.length}</span>
              </div>
              {oauthClients.map((client) => (
                <div className="aa-srv-row" key={client.clientId}>
                  <span className="k">{client.name}</span>
                  <span className="v aa-srv-client-value">
                    <code>{client.clientId}</code>
                    <span>{client.redirectUris.join(" ")}</span>
                  </span>
                  <button type="button" className="copy" onClick={() => deleteClient(client.clientId)} aria-label="Delete OAuth client">
                    <Icons.X size={13} />
                  </button>
                </div>
              ))}
              <ServiceInput label="Client name" value={clientName} onChange={setClientName} />
              <ServiceInput
                label="Redirect URIs"
                value={clientRedirectUris}
                placeholder="Space separated, e.g. agents-anywhere://oauth/callback"
                onChange={setClientRedirectUris}
              />
              <div className="aa-srv-row">
                <span className="k">New client</span>
                <span className="v">
                  <span className="badge">PKCE</span>
                </span>
                <button type="button" className="copy" disabled={oauthPending} onClick={createClient} aria-label="Create OAuth client">
                  <Icons.Plus size={13} />
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
                <span className="aa-word" style={{ fontSize: "17px" }}>
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

function defaultOAuthForm(): OAuthProviderConfig & { clientSecret: string } {
  return {
    enabled: false,
    provider: "oidc",
    label: "OAuth",
    authorizeUrl: "",
    tokenUrl: "",
    userInfoUrl: "",
    clientId: "",
    clientSecret: "",
    scopes: "openid profile email",
    usernameClaim: "preferred_username",
    subjectClaim: "sub",
    emailClaim: "email",
    nameClaim: "name",
  };
}

function ServiceInput({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <div className="aa-srv-row aa-srv-edit-row">
      <span className="k">{label}</span>
      <span className="v">
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
      </span>
      <span />
    </div>
  );
}
