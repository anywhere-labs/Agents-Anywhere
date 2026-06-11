import { useState } from "react";
import { BrandLogo } from "../../components/BrandLogo";
import { Icons } from "../../components/Icons";
import { AAWord } from "./AAWord";
import type { AuthCredentials } from "../../lib/api";

type LoginFormProps = {
  onSubmit: (creds: AuthCredentials) => void;
  loading: boolean;
  error: string | null;
  registrationOpen: boolean;
  onSwitchToRegister: () => void;
  onOAuth?: () => void;
  oauthLabel?: string;
};

export function LoginForm({
  onSubmit,
  loading,
  error,
  registrationOpen,
  onSwitchToRegister,
  onOAuth,
  oauthLabel,
}: LoginFormProps) {
  const [userId, setUserId] = useState("");
  const [pw, setPw] = useState("");
  const [showPw, setShowPw] = useState(false);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!userId || !pw || loading) return;
    onSubmit({ userId: userId.trim().toLowerCase(), password: pw });
  };

  return (
    <div className="aa-card">
      <div className="aa-hero">
        <div className="mark-box">
          <BrandLogo size={30} />
        </div>
        <h1>
          Sign in to <AAWord size="lg" />
        </h1>
        <p>Use the credentials your instance admin gave you.</p>
      </div>

      {error && (
        <div className="aa-error">
          <Icons.AlertCircle className="ico" size={14} />
          <span>{error}</span>
        </div>
      )}

      <form className="aa-form" onSubmit={submit}>
        <div className="aa-field">
          <label htmlFor="login-user">User ID</label>
          <div className="aa-input has-icon">
            <span className="leading">
              <Icons.User size={15} />
            </span>
            <input
              id="login-user"
              className="mono"
              type="text"
              placeholder="e.g. benson"
              value={userId}
              onChange={(e) => setUserId(e.target.value.replace(/\s/g, ""))}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              autoFocus
            />
          </div>
        </div>

        <div className="aa-field">
          <label htmlFor="login-pw">Password</label>
          <div className="aa-input has-icon">
            <span className="leading">
              <Icons.Lock size={15} />
            </span>
            <input
              id="login-pw"
              type={showPw ? "text" : "password"}
              placeholder="••••••••"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              autoComplete="current-password"
              required
            />
            <button
              type="button"
              className="eye"
              onClick={() => setShowPw((v) => !v)}
              aria-label={showPw ? "Hide password" : "Show password"}
            >
              {showPw ? <Icons.EyeOff size={15} /> : <Icons.Eye size={15} />}
            </button>
          </div>
        </div>

        <button
          type="submit"
          className={"aa-submit" + (loading ? " loading" : "")}
          disabled={loading}
        >
          {loading ? (
            <span className="spin" />
          ) : (
            <>
              Sign in <span className="kbd">↵</span>
            </>
          )}
        </button>
      </form>

      {onOAuth && (
        <button type="button" className="aa-oauth-button" disabled={loading} onClick={onOAuth}>
          <Icons.Globe size={15} />
          Sign in with {oauthLabel || "OAuth"}
        </button>
      )}

      <div className="aa-foot">
        {registrationOpen && (
          <span>
            New here?{" "}
            <button type="button" className="link" onClick={onSwitchToRegister}>
              Create an account
            </button>
          </span>
        )}
        <span style={{ fontSize: "var(--fs-xs)", color: "var(--text-faint)" }}>
          Forgot your password? Ask your instance admin to reset it.
        </span>
      </div>
    </div>
  );
}
