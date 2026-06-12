import { useCallback, useEffect, useState } from "react";
import { Icons } from "../../components/Icons";
import {
  ApiError,
  api,
  type InstanceSettings,
  type OAuthProviderConfig,
  type OAuthProviderConfigUpdate,
  type ServiceInfo,
} from "../../lib/api";

type ServicePageProps = {
  token: string;
  onBack: () => void;
};

type OAuthTemplateKey = "custom" | "github" | "gitlab" | "google";

type OAuthTemplate = {
  key: OAuthTemplateKey;
  label: string;
  defaultBaseUrl: string;
  apply: (baseUrl: string) => Partial<OAuthProviderConfigUpdate>;
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
  const [oauthDraft, setOauthDraft] = useState<OAuthProviderConfigUpdate | null>(null);
  const [oauthTemplate, setOauthTemplate] = useState<OAuthTemplateKey>("custom");
  const [oauthBaseUrl, setOauthBaseUrl] = useState("");
  const [oauthSaving, setOauthSaving] = useState(false);
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
      setOauthDraft(oauthDraftFromConfig(settingsBody.oauth));
      setOauthTemplate("custom");
      setOauthBaseUrl("");
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

  const updateOAuthDraft = (patch: Partial<OAuthProviderConfigUpdate>) => {
    setOauthDraft((current) => ({ ...(current ?? oauthDraftFromConfig(null)), ...patch }));
  };

  const applyOAuthTemplate = (key: OAuthTemplateKey, baseUrl?: string) => {
    setOauthTemplate(key);
    const template = oauthTemplates[key];
    const nextBaseUrl = baseUrl ?? (key === "custom" ? oauthBaseUrl : template.defaultBaseUrl);
    setOauthBaseUrl(nextBaseUrl);
    if (key !== "custom") updateOAuthDraft(template.apply(nextBaseUrl));
  };

  const updateOAuthBaseUrl = (nextBaseUrl: string) => {
    setOauthBaseUrl(nextBaseUrl);
    if (oauthTemplate !== "custom") {
      updateOAuthDraft(oauthTemplates[oauthTemplate].apply(nextBaseUrl));
    }
  };

  const saveOAuthProvider = async () => {
    if (!oauthDraft || oauthSaving) return;
    setOauthSaving(true);
    setError(null);
    try {
      const updated = await api.updateSettings(token, { oauth: oauthDraft });
      setSettings(updated);
      setOauthDraft(oauthDraftFromConfig(updated.oauth));
    } catch (err) {
      if (err instanceof ApiError) setError(err.detail);
      else setError("Failed to save OAuth provider.");
    } finally {
      setOauthSaving(false);
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

          {settings && oauthDraft && (
            <div className="aa-srv-card">
              <div className="hd">
                <h3>OAuth Sign-in Provider</h3>
              </div>
              <div className="body aa-oauth-provider-form">
                <div className="aa-srv-toggle">
                  <div className="info">
                    <span className="t">Enable OAuth sign-in</span>
                    <span className="s">
                      Configure the upstream OAuth/OIDC provider used on the web
                      sign-in page.
                    </span>
                  </div>
                  <label className="aa-srv-switch">
                    <input
                      type="checkbox"
                      checked={oauthDraft.enabled}
                      disabled={oauthSaving}
                      onChange={(e) => updateOAuthDraft({ enabled: e.target.checked })}
                    />
                    <span className="track" />
                    <span className="knob" />
                  </label>
                </div>

                <div className="aa-oauth-template-row">
                  <label className="aa-srv-field">
                    <span>Template</span>
                    <select
                      value={oauthTemplate}
                      onChange={(e) => applyOAuthTemplate(e.target.value as OAuthTemplateKey)}
                    >
                      {Object.values(oauthTemplates).map((template) => (
                        <option key={template.key} value={template.key}>
                          {template.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="aa-oauth-grid">
                  <label className="aa-srv-field">
                    <span>Base URL</span>
                    <input
                      value={oauthBaseUrl}
                      onChange={(e) => updateOAuthBaseUrl(e.target.value)}
                      placeholder={oauthTemplate === "custom" ? "https://idp.example.com" : oauthTemplates[oauthTemplate].defaultBaseUrl}
                    />
                  </label>
                  <label className="aa-srv-field">
                    <span>Client ID</span>
                    <input
                      value={oauthDraft.clientId}
                      onChange={(e) => updateOAuthDraft({ clientId: e.target.value })}
                    />
                  </label>
                  <label className="aa-srv-field">
                    <span>Client secret</span>
                    <input
                      type="password"
                      value={oauthDraft.clientSecret ?? ""}
                      onChange={(e) => updateOAuthDraft({ clientSecret: e.target.value })}
                      placeholder={settings.oauth ? "Leave blank to keep existing secret" : ""}
                    />
                  </label>
                  {oauthTemplate === "custom" && (
                    <>
                      <label className="aa-srv-field">
                        <span>Provider key</span>
                        <input
                          value={oauthDraft.provider}
                          onChange={(e) => updateOAuthDraft({ provider: e.target.value })}
                          placeholder="oidc"
                        />
                      </label>
                      <label className="aa-srv-field">
                        <span>Button label</span>
                        <input
                          value={oauthDraft.label}
                          onChange={(e) => updateOAuthDraft({ label: e.target.value })}
                          placeholder="OAuth"
                        />
                      </label>
                      <label className="aa-srv-field span-2">
                        <span>Authorize URL</span>
                        <input
                          value={oauthDraft.authorizeUrl}
                          onChange={(e) => updateOAuthDraft({ authorizeUrl: e.target.value })}
                          placeholder="https://idp.example.com/oauth/authorize"
                        />
                      </label>
                      <label className="aa-srv-field span-2">
                        <span>Token URL</span>
                        <input
                          value={oauthDraft.tokenUrl}
                          onChange={(e) => updateOAuthDraft({ tokenUrl: e.target.value })}
                          placeholder="https://idp.example.com/oauth/token"
                        />
                      </label>
                      <label className="aa-srv-field span-2">
                        <span>UserInfo URL</span>
                        <input
                          value={oauthDraft.userInfoUrl}
                          onChange={(e) => updateOAuthDraft({ userInfoUrl: e.target.value })}
                          placeholder="https://idp.example.com/oauth/userinfo"
                        />
                      </label>
                      <label className="aa-srv-field span-2">
                        <span>Scopes</span>
                        <input
                          value={oauthDraft.scopes}
                          onChange={(e) => updateOAuthDraft({ scopes: e.target.value })}
                          placeholder="openid profile email"
                        />
                      </label>
                      <label className="aa-srv-field">
                        <span>Username claim</span>
                        <input
                          value={oauthDraft.usernameClaim}
                          onChange={(e) => updateOAuthDraft({ usernameClaim: e.target.value })}
                        />
                      </label>
                      <label className="aa-srv-field">
                        <span>Subject claim</span>
                        <input
                          value={oauthDraft.subjectClaim}
                          onChange={(e) => updateOAuthDraft({ subjectClaim: e.target.value })}
                        />
                      </label>
                      <label className="aa-srv-field">
                        <span>Email claim</span>
                        <input
                          value={oauthDraft.emailClaim}
                          onChange={(e) => updateOAuthDraft({ emailClaim: e.target.value })}
                        />
                      </label>
                      <label className="aa-srv-field">
                        <span>Name claim</span>
                        <input
                          value={oauthDraft.nameClaim}
                          onChange={(e) => updateOAuthDraft({ nameClaim: e.target.value })}
                        />
                      </label>
                    </>
                  )}
                </div>

                <div className="aa-srv-actions">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      setOauthTemplate("custom");
                      setOauthBaseUrl("");
                      setOauthDraft(oauthDraftFromConfig(settings.oauth));
                    }}
                    disabled={oauthSaving}
                  >
                    Reset
                  </button>
                  <button type="button" onClick={saveOAuthProvider} disabled={oauthSaving}>
                    {oauthSaving ? "Saving…" : "Save provider"}
                  </button>
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

function oauthDraftFromConfig(config: OAuthProviderConfig | null): OAuthProviderConfigUpdate {
  return {
    enabled: config?.enabled ?? false,
    provider: config?.provider ?? "oidc",
    label: config?.label ?? "OAuth",
    authorizeUrl: config?.authorizeUrl ?? "",
    tokenUrl: config?.tokenUrl ?? "",
    userInfoUrl: config?.userInfoUrl ?? "",
    clientId: config?.clientId ?? "",
    clientSecret: "",
    scopes: config?.scopes ?? "openid profile email",
    usernameClaim: config?.usernameClaim ?? "preferred_username",
    subjectClaim: config?.subjectClaim ?? "sub",
    emailClaim: config?.emailClaim ?? "email",
    nameClaim: config?.nameClaim ?? "name",
  };
}

const oauthTemplates: Record<OAuthTemplateKey, OAuthTemplate> = {
  custom: {
    key: "custom",
    label: "Custom",
    defaultBaseUrl: "",
    apply: () => ({}),
  },
  github: {
    key: "github",
    label: "GitHub",
    defaultBaseUrl: "https://github.com",
    apply: (baseUrl) => {
      const root = normalizeBaseUrl(baseUrl || "https://github.com");
      return {
        provider: "github",
        label: "GitHub",
        authorizeUrl: `${root}/login/oauth/authorize`,
        tokenUrl: `${root}/login/oauth/access_token`,
        userInfoUrl: "https://api.github.com/user",
        scopes: "read:user user:email",
        usernameClaim: "login",
        subjectClaim: "id",
        emailClaim: "email",
        nameClaim: "name",
      };
    },
  },
  gitlab: {
    key: "gitlab",
    label: "GitLab",
    defaultBaseUrl: "https://gitlab.com",
    apply: (baseUrl) => {
      const root = normalizeBaseUrl(baseUrl || "https://gitlab.com");
      return {
        provider: "gitlab",
        label: "GitLab",
        authorizeUrl: `${root}/oauth/authorize`,
        tokenUrl: `${root}/oauth/token`,
        userInfoUrl: `${root}/oauth/userinfo`,
        scopes: "openid profile email",
        usernameClaim: "nickname",
        subjectClaim: "sub",
        emailClaim: "email",
        nameClaim: "name",
      };
    },
  },
  google: {
    key: "google",
    label: "Google",
    defaultBaseUrl: "https://accounts.google.com",
    apply: (baseUrl) => {
      const root = normalizeBaseUrl(baseUrl || "https://accounts.google.com");
      return {
        provider: "google",
        label: "Google",
        authorizeUrl: `${root}/o/oauth2/v2/auth`,
        tokenUrl: "https://oauth2.googleapis.com/token",
        userInfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
        scopes: "openid profile email",
        usernameClaim: "email",
        subjectClaim: "sub",
        emailClaim: "email",
        nameClaim: "name",
      };
    },
  },
};

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}
