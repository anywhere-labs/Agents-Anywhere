"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/routing";
import { Button } from "@/components/ui/button";
import {
  FormField,
  Identicon,
  InlineAlert,
  PasswordField,
  TextInput
} from "@/components/common";
import {
  AuthShell,
  ThemeSegment,
  AuthCard,
  type ThemeMode
} from "@/components/layout";
import {
  BootstrapForm,
  LoginForm,
  RegisterForm
} from "@/components/auth/auth-forms";
import { errorMessage } from "@/lib/api";
import {
  authApi,
  authResponseToSession,
  saveStoredSession,
  type AuthConfig,
  type AuthCredentials,
  type AuthResponse
} from "@/features/auth";

export type AuthMode = "login" | "register" | "bootstrap";

type OAuthPending = {
  status: "authenticated" | "needs_password" | "needs_registration";
  pendingToken: string;
  userId: string;
};

export interface AuthFlowProps {
  initialMode: AuthMode;
}

export function AuthFlow({ initialMode }: AuthFlowProps) {
  const t = useTranslations("auth");
  const router = useRouter();
  const [theme, setTheme] = React.useState<ThemeMode>("dark");
  const [config, setConfig] = React.useState<AuthConfig | null>(null);
  const [configError, setConfigError] = React.useState<string | null>(null);
  const [mode, setMode] = React.useState<AuthMode>(initialMode);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [oauthPending, setOauthPending] = React.useState<OAuthPending | null>(null);
  const [serverUrl, setServerUrl] = React.useState<string | undefined>(undefined);

  React.useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  React.useEffect(() => {
    setServerUrl(window.location.origin);
  }, []);

  React.useEffect(() => {
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
    authApi
      .config()
      .then((nextConfig) => {
        if (cancelled) return;
        setConfig(nextConfig);
        setMode((current) => {
          if (nextConfig.needsBootstrap) return "bootstrap";
          if (current === "bootstrap") return "login";
          return current;
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setConfigError(t("errors.config", { detail: errorMessage(err, t("errors.generic")) }));
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  React.useEffect(() => {
    if (!oauthPending || oauthPending.status !== "authenticated") return;
    setLoading(true);
    authApi
      .finalizeOAuth({ pendingToken: oauthPending.pendingToken })
      .then((result) => handleAuthed(result.auth))
      .catch((err: unknown) => {
        setError(errorMessage(err, t("errors.oauth")));
        setOauthPending(null);
      })
      .finally(() => setLoading(false));
  }, [oauthPending, t]);

  const switchTo = (nextMode: AuthMode) => {
    setError(null);
    setMode(nextMode);
    router.replace(nextMode === "login" ? "/login" : `/${nextMode}`);
  };

  const handleAuthed = (auth: AuthResponse) => {
    saveStoredSession(authResponseToSession(auth));
    router.replace("/");
  };

  const submitLogin = (credentials: AuthCredentials) =>
    submitAuth(() => authApi.login(credentials));

  const submitRegister = (credentials: AuthCredentials) =>
    submitAuth(() => authApi.register(credentials));

  const submitAuth = async (call: () => Promise<AuthResponse>) => {
    setError(null);
    setLoading(true);
    try {
      handleAuthed(await call());
    } catch (err) {
      setError(errorMessage(err, t("errors.generic")));
    } finally {
      setLoading(false);
    }
  };

  const startOAuth = async () => {
    setError(null);
    setLoading(true);
    try {
      const result = await authApi.startOAuth(window.location.href);
      window.location.assign(result.authorizeUrl);
    } catch (err) {
      setError(errorMessage(err, t("errors.oauth")));
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
      const result = await authApi.finalizeOAuth({
        pendingToken: oauthPending.pendingToken,
        userId: body.userId,
        password: body.password,
        setPassword: body.setPassword
      });
      handleAuthed(result.auth);
    } catch (err) {
      setError(errorMessage(err, t("errors.oauth")));
    } finally {
      setLoading(false);
    }
  };

  const actions = (
    <>
      <a
        href="https://github.com/anywhere-labs/Agents-Anywhere"
        target="_blank"
        rel="noreferrer"
        className="text-[var(--fs-sm)] text-[var(--text-mut)] no-underline hover:text-[var(--text)]"
      >
        GitHub
      </a>
      <a
        href="#docs"
        className="text-[var(--fs-sm)] text-[var(--text-mut)] no-underline hover:text-[var(--text)]"
      >
        Docs
      </a>
      <ThemeSegment
        value={theme}
        onValueChange={setTheme}
        label={t("theme.label")}
        lightLabel={t("theme.light")}
        darkLabel={t("theme.dark")}
      />
    </>
  );

  if (!config && !configError) {
    return (
      <AuthShell actions={actions} serverUrl={serverUrl}>
        <div className="flex items-center gap-2 text-[var(--fs-sm)] text-[var(--text-mut)]">
          <span className="size-3 animate-[klaw-spin_0.7s_linear_infinite] rounded-full border border-current border-t-transparent" />
          <span>{t("status.connecting")}</span>
        </div>
      </AuthShell>
    );
  }

  if (configError) {
    return (
      <AuthShell actions={actions} serverUrl={serverUrl}>
        <div className="w-[400px] max-w-full">
          <InlineAlert tone="danger">{configError}</InlineAlert>
        </div>
      </AuthShell>
    );
  }

  if (oauthPending && oauthPending.status !== "authenticated") {
    return (
      <AuthShell actions={actions} serverUrl={serverUrl}>
        <OAuthFinalizeForm
          mode={oauthPending.status}
          initialUserId={oauthPending.userId}
          loading={loading}
          error={error}
          onSubmit={finishOAuth}
          onCancel={() => setOauthPending(null)}
        />
      </AuthShell>
    );
  }

  const cfg = config;
  const view =
    mode === "bootstrap" ? (
      <BootstrapForm
        onSubmit={submitRegister}
        loading={loading}
        error={error}
        setupTokenExpiresAt={cfg?.setupTokenExpiresAt}
      />
    ) : mode === "register" ? (
      <RegisterForm
        onSubmit={submitRegister}
        loading={loading}
        error={error}
        onSwitchToLogin={() => switchTo("login")}
      />
    ) : (
      <LoginForm
        onSubmit={submitLogin}
        onOAuth={cfg?.oauthEnabled ? startOAuth : undefined}
        oauthLabel={cfg?.oauthProviderLabel ?? undefined}
        loading={loading}
        error={error}
        registrationOpen={Boolean(cfg?.registrationOpen)}
        onSwitchToRegister={() => switchTo("register")}
      />
    );

  return (
    <AuthShell actions={actions} serverUrl={serverUrl}>
      {view}
    </AuthShell>
  );
}

function OAuthFinalizeForm({
  mode,
  initialUserId,
  loading,
  error,
  onSubmit,
  onCancel
}: {
  mode: "needs_password" | "needs_registration";
  initialUserId: string;
  loading: boolean;
  error: string | null;
  onSubmit: (body: { userId?: string; password?: string; setPassword?: boolean }) => void;
  onCancel: () => void;
}) {
  const t = useTranslations("auth");
  const [userId, setUserId] = React.useState(initialUserId);
  const [password, setPassword] = React.useState("");
  const [setLocalPassword, setSetLocalPassword] = React.useState(false);
  const [choice, setChoice] = React.useState<"ask" | "yes" | "no">(
    mode === "needs_password" ? "ask" : "no",
  );
  const needsPassword = mode === "needs_password";
  const confirmExisting = needsPassword && choice === "yes";

  if (needsPassword && choice === "ask") {
    return (
      <AuthCard>
        <OAuthHero
          avatarId={initialUserId}
          avatarSize={56}
          title={t("oauth.matchTitle")}
          description={
            <>
              {t("oauth.matchDescriptionPrefix")}{" "}
              <strong className="font-mono font-medium text-[color:var(--text)]">
                {initialUserId}
              </strong>
              .
            </>
          }
        />

        {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}

        <div className="flex flex-col gap-3">
          <Button
            type="button"
            variant="emphasis"
            className="h-10 w-full text-[length:var(--fs-ui)]"
            onClick={() => setChoice("yes")}
          >
            {t("oauth.useMatchedAccount")}
          </Button>
          <Button
            type="button"
            variant="normal"
            className="h-10 w-full text-[length:var(--fs-ui)]"
            onClick={() => setChoice("no")}
          >
            {t("oauth.useAnotherUser")}
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t("oauth.back")}
          </Button>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard>
      <OAuthHero
        avatarId={userId}
        avatarSize={50}
        title={confirmExisting ? t("oauth.confirmTitle") : t("oauth.createTitle")}
        description={confirmExisting ? t("oauth.confirmDescription") : t("oauth.createDescription")}
      />

      {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}

      <form
        className="flex flex-col gap-3.5"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit({
            userId: userId.trim().toLowerCase(),
            password: password || undefined,
            setPassword: !confirmExisting && setLocalPassword
          });
        }}
      >
        <FormField label={t("fields.userId")} htmlFor="oauth-user">
          <TextInput
            id="oauth-user"
            mono
            value={userId}
            disabled={confirmExisting}
            onChange={(event) => setUserId(event.target.value.replace(/\s/g, ""))}
            required
          />
        </FormField>

        {confirmExisting || setLocalPassword ? (
          <FormField label={t("fields.password")} htmlFor="oauth-password">
            <PasswordField
              id="oauth-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              showLabel={t("actions.showPassword")}
              hideLabel={t("actions.hidePassword")}
            />
          </FormField>
        ) : (
          <label className="flex items-center gap-2 text-[var(--fs-sm)] text-[var(--text-mid)]">
            <input
              type="checkbox"
              checked={setLocalPassword}
              onChange={(event) => setSetLocalPassword(event.target.checked)}
            />
            <span>{t("oauth.setLocalPassword")}</span>
          </label>
        )}

        <Button
          type="submit"
          variant="emphasis"
          className="h-10 w-full text-[length:var(--fs-ui)]"
          disabled={loading}
        >
          {loading ? (
            <span className="size-3.5 animate-[klaw-spin_0.6s_linear_infinite] rounded-full border-[1.5px] border-current border-t-transparent" />
          ) : null}
          {confirmExisting ? t("oauth.linkSubmit") : t("oauth.createSubmit")}
        </Button>
        <Button type="button" variant="normal" className="h-10" onClick={onCancel}>
          {t("oauth.back")}
        </Button>
      </form>
    </AuthCard>
  );
}

function OAuthHero({
  avatarId,
  avatarSize,
  title,
  description
}: {
  avatarId: string;
  avatarSize: number;
  title: React.ReactNode;
  description: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3.5 text-center">
      <Identicon id={avatarId} size={avatarSize} />
      <h1 className="m-0 text-[length:var(--fs-xl)] font-semibold leading-tight tracking-normal text-[color:var(--text)]">
        {title}
      </h1>
      <p className="m-0 max-w-[34ch] text-wrap text-[length:var(--fs-ui)] leading-normal text-[color:var(--text-mut)]">
        {description}
      </p>
    </div>
  );
}
