import { useState } from "react";
import { BrandLogo } from "../../components/BrandLogo";
import { Icons } from "../../components/Icons";
import { AAWord } from "./AAWord";
import type { AuthCredentials } from "../../lib/api";
import {
  STRENGTH_LABEL,
  USER_ID_HINT,
  USER_ID_RE,
  passwordScore,
} from "./password";

type RegisterFormProps = {
  onSubmit: (creds: AuthCredentials) => void;
  loading: boolean;
  error: string | null;
  onSwitchToLogin: () => void;
};

export function RegisterForm({
  onSubmit,
  loading,
  error,
  onSwitchToLogin,
}: RegisterFormProps) {
  const [userId, setUserId] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [showPw, setShowPw] = useState(false);

  const score = passwordScore(pw);
  const mismatch = !!pw && !!pw2 && pw !== pw2;
  const tooShort = !!pw && pw.length < 8;
  const idValid = USER_ID_RE.test(userId);
  const idHint = userId ? (idValid ? "looks good" : USER_ID_HINT) : "";
  const ok = idValid && !!pw && !!pw2 && !mismatch && !tooShort;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ok || loading) return;
    onSubmit({ userId: userId.trim().toLowerCase(), password: pw });
  };

  return (
    <div className="aa-card">
      <div className="aa-hero">
        <div className="mark-box">
          <BrandLogo size={30} />
        </div>
        <h1>Create an account</h1>
        <p>
          You're joining a self-hosted <AAWord /> instance.
        </p>
      </div>

      {error && (
        <div className="aa-error">
          <Icons.AlertCircle className="ico" size={14} />
          <span>{error}</span>
        </div>
      )}

      <form className="aa-form" onSubmit={submit}>
        <div className="aa-field">
          <div className="row">
            <label htmlFor="reg-user">User ID</label>
            {userId && (
              <span
                className="hint"
                style={{
                  color: idValid
                    ? "oklch(0.72 0.14 152)"
                    : "oklch(0.78 0.14 25)",
                }}
              >
                {idHint}
              </span>
            )}
          </div>
          <div className="aa-input has-icon">
            <span className="leading">
              <Icons.User size={15} />
            </span>
            <input
              id="reg-user"
              className="mono"
              type="text"
              placeholder="enter your username"
              value={userId}
              onChange={(e) =>
                setUserId(
                  e.target.value
                    .replace(/[^a-zA-Z0-9_-]/g, "")
                    .toLowerCase(),
                )
              }
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              autoFocus
            />
          </div>
        </div>

        <div className="aa-field">
          <label htmlFor="reg-pw">Password</label>
          <div className="aa-input has-icon">
            <span className="leading">
              <Icons.Lock size={15} />
            </span>
            <input
              id="reg-pw"
              type={showPw ? "text" : "password"}
              placeholder="At least 8 characters"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              autoComplete="new-password"
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
          {pw && (
            <div className={"aa-strength s" + score}>
              <div className="bars">
                <i />
                <i />
                <i />
                <i />
              </div>
              <span className="label">{STRENGTH_LABEL[score]}</span>
            </div>
          )}
        </div>

        <div className="aa-field">
          <label htmlFor="reg-pw2">Confirm password</label>
          <div className="aa-input has-icon">
            <span className="leading">
              <Icons.Lock size={15} />
            </span>
            <input
              id="reg-pw2"
              type={showPw ? "text" : "password"}
              placeholder="Repeat password"
              value={pw2}
              onChange={(e) => setPw2(e.target.value)}
              autoComplete="new-password"
              required
            />
          </div>
          {mismatch && (
            <span
              className="hint"
              style={{ color: "oklch(0.78 0.14 25)" }}
            >
              Passwords don't match
            </span>
          )}
        </div>

        <button
          type="submit"
          disabled={!ok || loading}
          style={!ok && !loading ? { opacity: 0.5, cursor: "not-allowed" } : undefined}
          className={"aa-submit" + (loading ? " loading" : "")}
        >
          {loading ? (
            <span className="spin" />
          ) : (
            <>
              Create account <span className="kbd">↵</span>
            </>
          )}
        </button>
      </form>

      <div className="aa-foot">
        <span>
          Already have an account?{" "}
          <button type="button" className="link" onClick={onSwitchToLogin}>
            Sign in
          </button>
        </span>
      </div>
    </div>
  );
}
