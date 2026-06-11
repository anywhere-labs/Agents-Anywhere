import { useEffect, useState } from "react";
import "./auth.css";
import { AuthChrome } from "./AuthChrome";
import { LoginForm } from "./LoginForm";
import { RegisterForm } from "./RegisterForm";
import { BootstrapForm } from "./BootstrapForm";
import {
  ApiError,
  api,
  type AuthConfig,
  type AuthCredentials,
  type AuthResponse,
} from "../../lib/api";
import type { Theme } from "../../lib/theme";
import {
  createPasswordVerifier,
  derivePasswordVerifier,
} from "../../lib/passwordVerifier";
import { Identicon } from "../../components/Identicon";

type Mode = "login" | "register" | "bootstrap";
type OAuthPending = {
  status: "authenticated" | "needs_password" | "needs_registration";
  pendingToken: string;
  userId: string;
};

type AuthPageProps = {
  theme: Theme;
  onSetTheme: (theme: Theme) => void;
  onAuthed: (auth: AuthResponse) => void;
  serverUrl?: string;
};

const DEFAULT_SERVER_URL = window.location.origin;

export function AuthPage({
  theme,
  onSetTheme,
  onAuthed,
  serverUrl = DEFAULT_SERVER_URL,
}: AuthPageProps) {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("login");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [oauthPending, setOauthPending] = useState<OAuthPending | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const pendingToken = params.get("oauth_pending");
    const oauthStatus = params.get("oauth_status") as OAuthPending["status"] | null;
    const oauthUser = params.get("oauth_user") || "";
    const oauthError = params.get("oauth_error");
    if (pendingToken && oauthStatus) {
      setOauthPending({ status: oauthStatus, pendingToken, userId: oauthUser });
      window.history.replaceState({}, "", window.location.pathname + window.location.hash);
    } else if (oauthError) {
      setError(oauthError);
      window.history.replaceState({}, "", window.location.pathname + window.location.hash);
    }
    let cancelled = false;
    api
      .authConfig()
      .then((c) => {
        if (cancelled) return;
        setConfig(c);
        setMode(c.needsBootstrap ? "bootstrap" : "login");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message =
          err instanceof ApiError
            ? `Couldn't reach the server (${err.status || "no response"}). ${err.detail}`
            : "Couldn't reach the server.";
        setConfigError(message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!oauthPending || oauthPending.status !== "authenticated") return;
    setLoading(true);
    api
      .finalizeOAuth({ pendingToken: oauthPending.pendingToken })
      .then((result) => onAuthed(result.auth))
      .catch((err: unknown) => {
        if (err instanceof ApiError) setError(err.detail);
        else setError("OAuth sign-in failed.");
        setOauthPending(null);
      })
      .finally(() => setLoading(false));
  }, [oauthPending, onAuthed]);

  const switchTo = (next: Mode) => {
    setError(null);
    setMode(next);
  };

  const handleSubmit = (call: (creds: AuthCredentials) => Promise<AuthResponse>) =>
    async (creds: AuthCredentials) => {
      setError(null);
      setLoading(true);
      try {
        let payload = creds;
        if (creds.password) {
          if (call === api.login) {
            const { salt } = await api.passwordSalt(creds.userId);
            payload = {
              userId: creds.userId,
              passwordVerifier: await derivePasswordVerifier(creds.password, salt),
            };
          } else {
            payload = {
              userId: creds.userId,
              ...(await createPasswordVerifier(creds.password)),
              ...(creds.setupToken ? { setupToken: creds.setupToken } : {}),
            };
          }
        }
        const result = await call(payload);
        onAuthed(result);
      } catch (err) {
        if (err instanceof ApiError) setError(err.detail);
        else setError("Something went wrong.");
      } finally {
        setLoading(false);
      }
    };

  const startOAuth = async () => {
    setError(null);
    setLoading(true);
    try {
      const result = await api.startOAuth(window.location.href);
      window.location.assign(result.authorizeUrl);
    } catch (err) {
      if (err instanceof ApiError) setError(err.detail);
      else setError("OAuth sign-in failed.");
      setLoading(false);
    }
  };

  const finishOAuth = async (body: {
    userId?: string;
    password?: string;
    setPassword?: boolean;
  }) => {
    if (!oauthPending) return;
    setError(null);
    setLoading(true);
    try {
      const payload: Parameters<typeof api.finalizeOAuth>[0] = {
        pendingToken: oauthPending.pendingToken,
        userId: body.userId,
        setPassword: body.setPassword,
      };
      if (body.password) {
        if (body.setPassword) {
          Object.assign(payload, await createPasswordVerifier(body.password));
        } else {
          const { salt } = await api.passwordSalt(body.userId || oauthPending.userId);
          payload.passwordVerifier = await derivePasswordVerifier(body.password, salt);
        }
      }
      const result = await api.finalizeOAuth(payload);
      onAuthed(result.auth);
    } catch (err) {
      if (err instanceof ApiError) setError(err.detail);
      else setError("OAuth sign-in failed.");
    } finally {
      setLoading(false);
    }
  };

  // Loading the public /auth/config — keep the chrome blank to avoid flashing
  // the wrong view (login vs bootstrap).
  if (!config && !configError) {
    return (
      <div className="aa-boot">
        <span className="spin" />
        <span>Connecting</span>
      </div>
    );
  }

  if (configError) {
    return (
      <AuthChrome
        theme={theme}
        onSetTheme={onSetTheme}
        serverUrl={serverUrl}
      >
        <div className="aa-card">
          <div className="aa-error" role="alert">
            <span>{configError}</span>
          </div>
        </div>
      </AuthChrome>
    );
  }

  const cfg = config!;
  if (oauthPending && oauthPending.status !== "authenticated") {
    return (
      <AuthChrome theme={theme} onSetTheme={onSetTheme} serverUrl={serverUrl}>
        <OAuthFinalizeCard
          mode={oauthPending.status}
          initialUserId={oauthPending.userId}
          loading={loading}
          error={error}
          onSubmit={finishOAuth}
          onCancel={() => setOauthPending(null)}
        />
      </AuthChrome>
    );
  }

  const view =
    mode === "bootstrap" ? (
      <BootstrapForm
        onSubmit={handleSubmit(api.register)}
        loading={loading}
        error={error}
        setupTokenExpiresAt={cfg.setupTokenExpiresAt}
      />
    ) : mode === "register" ? (
      <RegisterForm
        onSubmit={handleSubmit(api.register)}
        loading={loading}
        error={error}
        onSwitchToLogin={() => switchTo("login")}
      />
    ) : (
      <LoginForm
        onSubmit={handleSubmit(api.login)}
        onOAuth={cfg.oauthEnabled ? startOAuth : undefined}
        oauthLabel={cfg.oauthProviderLabel ?? undefined}
        loading={loading}
        error={error}
        registrationOpen={cfg.registrationOpen}
        onSwitchToRegister={() => switchTo("register")}
      />
    );

  return (
    <AuthChrome
      theme={theme}
      onSetTheme={onSetTheme}
      serverUrl={serverUrl}
    >
      {view}
    </AuthChrome>
  );
}

function OAuthFinalizeCard({
  mode,
  initialUserId,
  loading,
  error,
  onSubmit,
  onCancel,
}: {
  mode: "needs_password" | "needs_registration";
  initialUserId: string;
  loading: boolean;
  error: string | null;
  onSubmit: (body: { userId?: string; password?: string; setPassword?: boolean }) => void;
  onCancel: () => void;
}) {
  const [userId, setUserId] = useState(initialUserId);
  const [password, setPassword] = useState("");
  const [setLocalPassword, setSetLocalPassword] = useState(false);
  const [choice, setChoice] = useState<"ask" | "yes" | "no">(
    mode === "needs_password" ? "ask" : "no",
  );
  const needsPassword = mode === "needs_password";
  const confirmingExisting = needsPassword && choice === "yes";

  if (needsPassword && choice === "ask") {
    return (
      <div className="aa-card">
        <div className="aa-hero">
          <Identicon id={initialUserId} size={56} />
          <h1>Is this your account?</h1>
          <p>
            OAuth matched the local account{" "}
            <strong className="aa-oauth-user">{initialUserId}</strong>.
          </p>
        </div>
        {error && <div className="aa-error">{error}</div>}
        <div className="aa-oauth-choice">
          <button type="button" className="aa-submit" onClick={() => setChoice("yes")}>
            Yes, link this account
          </button>
          <button type="button" className="aa-oauth-secondary" onClick={() => setChoice("no")}>
            No, use another user ID
          </button>
          <button type="button" className="aa-oauth-text-button" onClick={onCancel}>
            Back to sign in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="aa-card">
      <div className="aa-hero">
        <Identicon id={userId} size={50} />
        <h1>{confirmingExisting ? "Confirm your password" : "Choose your user ID"}</h1>
        <p>
          {confirmingExisting
            ? "Enter the local account password to link this OAuth identity."
            : "Create a local account for this OAuth identity."}
        </p>
      </div>
      {error && <div className="aa-error">{error}</div>}
      <form
        className="aa-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit({
            userId: userId.trim().toLowerCase(),
            password: password || undefined,
            setPassword: !confirmingExisting && setLocalPassword,
          });
        }}
      >
        <div className="aa-field">
          <label htmlFor="oauth-user">User ID</label>
          <div className="aa-input">
            <input
              id="oauth-user"
              className="mono"
              value={userId}
              disabled={confirmingExisting}
              onChange={(event) => setUserId(event.target.value.replace(/\s/g, ""))}
              required
            />
          </div>
        </div>
        {confirmingExisting ? (
          <div className="aa-field">
            <label htmlFor="oauth-password">Password</label>
            <div className="aa-input">
              <input
                id="oauth-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </div>
          </div>
        ) : (
          <label className="aa-oauth-check">
            <input
              type="checkbox"
              checked={setLocalPassword}
              onChange={(event) => setSetLocalPassword(event.target.checked)}
            />
            <span>Set a local password for this account</span>
          </label>
        )}
        {!confirmingExisting && setLocalPassword && (
          <div className="aa-field">
            <label htmlFor="oauth-new-password">Password</label>
            <div className="aa-input">
              <input
                id="oauth-new-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </div>
          </div>
        )}
        <button type="submit" className={"aa-submit" + (loading ? " loading" : "")} disabled={loading}>
          {loading ? <span className="spin" /> : confirmingExisting ? "Link and sign in" : "Create and sign in"}
        </button>
        <button type="button" className="aa-oauth-secondary" onClick={onCancel}>
          Back to sign in
        </button>
      </form>
    </div>
  );
}
