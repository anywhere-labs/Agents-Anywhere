"use client";

import * as React from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { AuthShell, ThemeSegment, type ThemeMode } from "@/components/layout";
import { BootstrapForm, LoginForm, RegisterForm } from "@/components/auth/auth-forms";

export type AuthPreviewMode = "login" | "register" | "bootstrap";

export function AuthPreview({ mode }: { mode: AuthPreviewMode }) {
  const t = useTranslations("auth");
  const locale = useLocale();
  const [theme, setTheme] = React.useState<ThemeMode>("dark");

  React.useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

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
      <Link
        href={`/${locale}`}
        className="text-[var(--fs-sm)] text-[var(--text-mut)] no-underline hover:text-[var(--text)]"
      >
        {t("preview.home")}
      </Link>
      <ThemeSegment
        value={theme}
        onValueChange={setTheme}
        label={t("theme.label")}
        lightLabel={t("theme.light")}
        darkLabel={t("theme.dark")}
      />
    </>
  );

  return (
    <AuthShell actions={actions} serverUrl="http://127.0.0.1:8000">
      {mode === "register" ? (
        <RegisterForm />
      ) : mode === "bootstrap" ? (
        <BootstrapForm
          setupTokenExpiresAt={new Date(Date.now() + 9 * 60 * 1000 + 42 * 1000).toISOString()}
        />
      ) : (
        <LoginForm oauthLabel="OAuth" />
      )}
    </AuthShell>
  );
}
