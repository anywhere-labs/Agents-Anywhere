"use client";

import * as React from "react";
import { AlertCircle, Globe, Key, Lock, Shield, User } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  FormField,
  InlineAlert,
  PasswordField,
  TextInput
} from "@/components/common";
import { AuthCard } from "@/components/layout";
import { PasswordStrength } from "@/components/auth/password-strength";
import { USER_ID_RE, passwordScore } from "@/components/auth/password";

export type AuthCredentials = {
  userId: string;
  password: string;
  setupToken?: string;
};

export interface LoginFormProps {
  loading?: boolean;
  error?: string | null;
  registrationOpen?: boolean;
  oauthLabel?: string;
  onSubmit?: (credentials: AuthCredentials) => void;
  onOAuth?: () => void;
  onSwitchToRegister?: () => void;
}

export function LoginForm({
  loading = false,
  error = null,
  registrationOpen = true,
  oauthLabel,
  onSubmit,
  onOAuth,
  onSwitchToRegister
}: LoginFormProps) {
  const t = useTranslations("auth");
  const [userId, setUserId] = React.useState("");
  const [password, setPassword] = React.useState("");
  const ready = userId.trim().length > 0 && password.length > 0 && !loading;

  return (
    <AuthCard>
      <AuthHero title={t("login.title")} description={t("login.description")} />
      {error ? <AuthError>{error}</AuthError> : null}
      <form
        className="flex flex-col gap-3.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          onSubmit?.({
            userId: userId.trim().toLowerCase(),
            password
          });
        }}
      >
        <FormField label={t("fields.userId")} htmlFor="login-user">
          <IconInput icon={<User aria-hidden="true" />}>
            <TextInput
              id="login-user"
              mono
              placeholder={t("login.userPlaceholder")}
              value={userId}
              onChange={(event) => setUserId(event.target.value.replace(/\s/g, ""))}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
            />
          </IconInput>
        </FormField>

        <FormField label={t("fields.password")} htmlFor="login-password">
          <IconInput icon={<Lock aria-hidden="true" />}>
            <PasswordField
              id="login-password"
              placeholder={t("login.passwordPlaceholder")}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
              showLabel={t("actions.showPassword")}
              hideLabel={t("actions.hidePassword")}
            />
          </IconInput>
        </FormField>

        <Button type="submit" variant="emphasis" className="h-10" disabled={!ready}>
          {loading ? <Spinner /> : null}
          {t("login.submit")}
          {!loading ? <span className="font-mono text-[var(--fs-xs)]">↵</span> : null}
        </Button>
      </form>

      {onOAuth ? (
        <Button type="button" variant="normal" className="h-10" disabled={loading} onClick={onOAuth}>
          <Globe aria-hidden="true" />
          {t("login.oauth", { provider: oauthLabel || "OAuth" })}
        </Button>
      ) : null}

      <div className="flex flex-col items-center gap-1 text-center text-[var(--fs-sm)] text-[var(--text-mut)]">
        {registrationOpen ? (
          <span>
            {t("login.newHere")}{" "}
            <button
              type="button"
              className="text-[var(--text)] underline decoration-[var(--border-lg)] underline-offset-2 hover:decoration-[var(--text)]"
              onClick={onSwitchToRegister}
            >
              {t("login.createAccount")}
            </button>
          </span>
        ) : null}
        <span className="text-[var(--fs-xs)] text-[var(--text-faint)]">
          {t("login.forgot")}
        </span>
      </div>
    </AuthCard>
  );
}

export interface RegisterFormProps {
  loading?: boolean;
  error?: string | null;
  onSubmit?: (credentials: AuthCredentials) => void;
  onSwitchToLogin?: () => void;
}

export function RegisterForm({
  loading = false,
  error = null,
  onSubmit,
  onSwitchToLogin
}: RegisterFormProps) {
  const t = useTranslations("auth");
  const [userId, setUserId] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const score = passwordScore(password);
  const idValid = USER_ID_RE.test(userId);
  const mismatch = Boolean(password && confirmPassword && password !== confirmPassword);
  const tooShort = Boolean(password && password.length < 8);
  const ready =
    idValid &&
    password.length > 0 &&
    confirmPassword.length > 0 &&
    !mismatch &&
    !tooShort &&
    !loading;

  return (
    <AuthCard>
      <AuthHero title={t("register.title")} description={t("register.description")} />
      {error ? <AuthError>{error}</AuthError> : null}
      <form
        className="flex flex-col gap-3.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          onSubmit?.({
            userId: userId.trim().toLowerCase(),
            password
          });
        }}
      >
        <FormField
          label={t("fields.userId")}
          htmlFor="register-user"
          hint={userId ? (idValid ? t("register.userOk") : t("register.userHint")) : null}
        >
          <IconInput icon={<User aria-hidden="true" />}>
            <TextInput
              id="register-user"
              mono
              placeholder={t("login.userPlaceholder")}
              value={userId}
              onChange={(event) =>
                setUserId(
                  event.target.value.replace(/[^a-zA-Z0-9_-]/g, "").toLowerCase(),
                )
              }
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
            />
          </IconInput>
        </FormField>

        <PasswordCreateFields
          password={password}
          confirmPassword={confirmPassword}
          onPasswordChange={setPassword}
          onConfirmPasswordChange={setConfirmPassword}
          score={score}
          mismatch={mismatch}
        />

        <Button type="submit" variant="emphasis" className="h-10" disabled={!ready}>
          {loading ? <Spinner /> : null}
          {t("register.submit")}
          {!loading ? <span className="font-mono text-[var(--fs-xs)]">↵</span> : null}
        </Button>
      </form>

      <div className="text-center text-[var(--fs-sm)] text-[var(--text-mut)]">
        {t("register.haveAccount")}{" "}
        <button
          type="button"
          className="text-[var(--text)] underline decoration-[var(--border-lg)] underline-offset-2 hover:decoration-[var(--text)]"
          onClick={onSwitchToLogin}
        >
          {t("register.signIn")}
        </button>
      </div>
    </AuthCard>
  );
}

export interface BootstrapFormProps {
  loading?: boolean;
  error?: string | null;
  setupTokenExpiresAt?: string | null;
  onSubmit?: (credentials: AuthCredentials) => void;
}

export function BootstrapForm({
  loading = false,
  error = null,
  setupTokenExpiresAt = null,
  onSubmit
}: BootstrapFormProps) {
  const t = useTranslations("auth");
  const [setupToken, setSetupToken] = React.useState("");
  const [userId, setUserId] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [, setTick] = React.useState(0);

  React.useEffect(() => {
    if (!setupTokenExpiresAt) return;
    const id = window.setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => window.clearInterval(id);
  }, [setupTokenExpiresAt]);

  const score = passwordScore(password);
  const idValid = USER_ID_RE.test(userId);
  const mismatch = Boolean(password && confirmPassword && password !== confirmPassword);
  const tooShort = Boolean(password && password.length < 8);
  const ready =
    setupToken.trim().length > 0 &&
    idValid &&
    password.length > 0 &&
    confirmPassword.length > 0 &&
    !mismatch &&
    !tooShort &&
    !loading;
  const remaining = formatRemaining(setupTokenExpiresAt);

  return (
    <AuthCard>
      <AuthHero title={t("bootstrap.title")} description={t("bootstrap.description")} />
      <InlineAlert tone={remaining.expired ? "danger" : "neutral"}>
        <div className="flex items-start gap-2">
          <Shield className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>
            {t("bootstrap.setupHint")}{" "}
            {remaining.text ? (
              <span className="font-mono text-[var(--text-mut)]">
                {remaining.text}
              </span>
            ) : null}
          </span>
        </div>
      </InlineAlert>
      {error ? <AuthError>{error}</AuthError> : null}
      <form
        className="flex flex-col gap-3.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          onSubmit?.({
            userId: userId.trim().toLowerCase(),
            password,
            setupToken: setupToken.trim()
          });
        }}
      >
        <FormField label={t("fields.setupToken")} htmlFor="bootstrap-token">
          <IconInput icon={<Key aria-hidden="true" />}>
            <TextInput
              id="bootstrap-token"
              mono
              placeholder={t("bootstrap.tokenPlaceholder")}
              value={setupToken}
              onChange={(event) => setSetupToken(event.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              required
            />
          </IconInput>
        </FormField>

        <FormField label={t("fields.adminUserId")} htmlFor="bootstrap-user">
          <IconInput icon={<Shield aria-hidden="true" />}>
            <TextInput
              id="bootstrap-user"
              mono
              placeholder={t("bootstrap.userPlaceholder")}
              value={userId}
              onChange={(event) =>
                setUserId(
                  event.target.value.replace(/[^a-zA-Z0-9_-]/g, "").toLowerCase(),
                )
              }
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
            />
          </IconInput>
        </FormField>

        <PasswordCreateFields
          password={password}
          confirmPassword={confirmPassword}
          onPasswordChange={setPassword}
          onConfirmPasswordChange={setConfirmPassword}
          score={score}
          mismatch={mismatch}
          passwordLabel={t("fields.adminPassword")}
          confirmLabel={t("fields.confirm")}
        />

        <Button type="submit" variant="emphasis" className="h-10" disabled={!ready}>
          {loading ? <Spinner /> : null}
          {t("bootstrap.submit")}
          {!loading ? <span className="font-mono text-[var(--fs-xs)]">↵</span> : null}
        </Button>
      </form>
    </AuthCard>
  );
}

function AuthHero({
  title,
  description
}: {
  title: React.ReactNode;
  description: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3.5 text-center">
      <h1 className="m-0 text-[var(--fs-xl)] font-semibold leading-tight tracking-normal text-[var(--text)]">
        {title}
      </h1>
      <p className="m-0 max-w-[34ch] text-[var(--fs-ui)] text-[var(--text-mut)]">
        {description}
      </p>
    </div>
  );
}

function AuthError({ children }: { children: React.ReactNode }) {
  return (
    <InlineAlert tone="danger">
      <div className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <span>{children}</span>
      </div>
    </InlineAlert>
  );
}

function IconInput({
  icon,
  children
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="relative flex items-center">
      <span className="pointer-events-none absolute left-3 z-10 flex size-[18px] items-center justify-center text-[var(--text-mut)] [&_svg]:size-[15px]">
        {icon}
      </span>
      <div className="w-full [&_input]:pl-9">{children}</div>
    </div>
  );
}

function PasswordCreateFields({
  password,
  confirmPassword,
  onPasswordChange,
  onConfirmPasswordChange,
  score,
  mismatch,
  passwordLabel,
  confirmLabel
}: {
  password: string;
  confirmPassword: string;
  onPasswordChange: (value: string) => void;
  onConfirmPasswordChange: (value: string) => void;
  score: number;
  mismatch: boolean;
  passwordLabel?: string;
  confirmLabel?: string;
}) {
  const t = useTranslations("auth");

  return (
    <>
      <FormField label={passwordLabel ?? t("fields.password")} htmlFor="auth-password">
        <IconInput icon={<Lock aria-hidden="true" />}>
          <PasswordField
            id="auth-password"
            placeholder={t("register.passwordPlaceholder")}
            value={password}
            onChange={(event) => onPasswordChange(event.target.value)}
            autoComplete="new-password"
            required
            showLabel={t("actions.showPassword")}
            hideLabel={t("actions.hidePassword")}
          />
        </IconInput>
        {password ? (
          <PasswordStrength
            score={score}
            label={t(`passwordStrength.${score}`)}
          />
        ) : null}
      </FormField>

      <FormField
        label={confirmLabel ?? t("fields.confirmPassword")}
        htmlFor="auth-confirm-password"
        error={mismatch ? t("register.passwordMismatch") : null}
      >
        <IconInput icon={<Lock aria-hidden="true" />}>
          <PasswordField
            id="auth-confirm-password"
            placeholder={t("register.confirmPlaceholder")}
            value={confirmPassword}
            onChange={(event) => onConfirmPasswordChange(event.target.value)}
            autoComplete="new-password"
            required
            showLabel={t("actions.showPassword")}
            hideLabel={t("actions.hidePassword")}
          />
        </IconInput>
      </FormField>
    </>
  );
}

function Spinner() {
  return (
    <span className="size-3 animate-[klaw-spin_0.7s_linear_infinite] rounded-full border border-current border-t-transparent" />
  );
}

function formatRemaining(expiresAt: string | null): {
  text: string;
  expired: boolean;
} {
  if (!expiresAt) return { text: "", expired: false };
  const target = new Date(expiresAt).getTime();
  if (Number.isNaN(target)) return { text: "", expired: false };
  const diffMs = target - Date.now();
  if (diffMs <= 0) return { text: "expired", expired: true };
  const totalSec = Math.floor(diffMs / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return { text: `${min}m ${String(sec).padStart(2, "0")}s`, expired: false };
}
