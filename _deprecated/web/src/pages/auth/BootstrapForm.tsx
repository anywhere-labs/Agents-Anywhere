import { useEffect, useState } from "react";
import { Icons } from "../../components/Icons";
import { AAWord } from "./AAWord";
import type { AuthCredentials } from "../../lib/api";
import { STRENGTH_LABEL, USER_ID_RE, passwordScore } from "./password";

type BootstrapFormProps = {
  onSubmit: (creds: AuthCredentials) => void;
  loading: boolean;
  error: string | null;
  setupTokenExpiresAt: string | null;
};

function formatRemaining(expiresAt: string | null): {
  text: string;
  expired: boolean;
} {
  if (!expiresAt) return { text: "", expired: false };
  const target = new Date(expiresAt).getTime();
  if (Number.isNaN(target)) return { text: "", expired: false };
  const diffMs = target - Date.now();
  if (diffMs <= 0) {
    return {
      text: "Token expired — a new one was generated; check the server log",
      expired: true,
    };
  }
  const totalSec = Math.floor(diffMs / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return {
    text: `Token valid for ${min}m ${String(sec).padStart(2, "0")}s`,
    expired: false,
  };
}

export function BootstrapForm({
  onSubmit,
  loading,
  error,
  setupTokenExpiresAt,
}: BootstrapFormProps) {
  const [userId, setUserId] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [showPw, setShowPw] = useState(false);

  // Re-render every second so the countdown ticks. Cheap (a single number diff).
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!setupTokenExpiresAt) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [setupTokenExpiresAt]);

  const remaining = formatRemaining(setupTokenExpiresAt);

  const score = passwordScore(pw);
  const mismatch = !!pw && !!pw2 && pw !== pw2;
  const tooShort = !!pw && pw.length < 8;
  const idValid = USER_ID_RE.test(userId);
  const tokenValid = setupToken.trim().length > 0;
  const ok = idValid && !!pw && !!pw2 && !mismatch && !tooShort && tokenValid;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ok || loading) return;
    onSubmit({
      userId: userId.trim().toLowerCase(),
      password: pw,
      setupToken: setupToken.trim(),
    });
  };

  return (
    <div className="aa-card">
      <div className="aa-hero">
        <h1>
          Welcome to <AAWord size="lg" />
        </h1>
        <p>
          Fresh install — the account you create here becomes the instance admin.
        </p>
      </div>

      <div className="aa-setup-hint">
        <div className="lead">
          <Icons.Shield className="ico" size={14} />
          <span>
            Copy the <code>setup-token</code> from the server log to continue.
          </span>
        </div>
        {remaining.text && (
          <span
            className={"countdown" + (remaining.expired ? " expired" : "")}
          >
            {remaining.text}
          </span>
        )}
      </div>

      {error && (
        <div className="aa-error">
          <Icons.AlertCircle className="ico" size={14} />
          <span>{error}</span>
        </div>
      )}

      <form className="aa-form" onSubmit={submit}>
        <div className="aa-field">
          <label htmlFor="boot-token">Setup token</label>
          <div className="aa-input has-icon">
            <span className="leading">
              <Icons.Key size={15} />
            </span>
            <input
              id="boot-token"
              className="mono"
              type="text"
              placeholder="Paste the token from the server log"
              value={setupToken}
              onChange={(e) => setSetupToken(e.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              required
              autoFocus
            />
          </div>
        </div>

        <div className="aa-field">
          <label htmlFor="boot-user">Admin user ID</label>
          <div className="aa-input has-icon">
            <span className="leading">
              <Icons.Shield size={15} />
            </span>
            <input
              id="boot-user"
              className="mono"
              type="text"
              placeholder="e.g. admin"
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
            />
          </div>
        </div>

        <div className="aa-field">
          <label htmlFor="boot-pw">Admin password</label>
          <div className="aa-input has-icon">
            <span className="leading">
              <Icons.Lock size={15} />
            </span>
            <input
              id="boot-pw"
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
          <label htmlFor="boot-pw2">Confirm</label>
          <div className="aa-input has-icon">
            <span className="leading">
              <Icons.Lock size={15} />
            </span>
            <input
              id="boot-pw2"
              type={showPw ? "text" : "password"}
              placeholder="Repeat password"
              value={pw2}
              onChange={(e) => setPw2(e.target.value)}
              autoComplete="new-password"
              required
            />
          </div>
          {mismatch && (
            <span className="hint" style={{ color: "oklch(0.78 0.14 25)" }}>
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
              Create admin &amp; continue <span className="kbd">↵</span>
            </>
          )}
        </button>
      </form>
    </div>
  );
}
