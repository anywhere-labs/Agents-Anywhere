import { useEffect, useRef, useState, type FormEvent } from "react";
import { Icons } from "../../components/Icons";
import { Identicon } from "../../components/Identicon";
import { ApiError, api, type AuthMe } from "../../lib/api";
import {
  createPasswordVerifier,
  derivePasswordVerifier,
} from "../../lib/passwordVerifier";
import { passwordScore, STRENGTH_LABEL } from "../auth/password";

type AccountModalProps = {
  open: boolean;
  onClose: () => void;
  me: AuthMe;
  token: string;
  onAvatarChange: (avatar: string | null) => void;
};

// Resize an uploaded image to a max 256×256 PNG data URL.
// Keeps the original aspect ratio with center-crop semantics.
async function resizeToDataUrl(file: File, max = 256): Promise<string> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("could not decode image"));
      el.src = objectUrl;
    });
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2d context unavailable");
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export function AccountModal({
  open,
  onClose,
  me,
  token,
  onAvatarChange,
}: AccountModalProps) {
  if (!open) return null;

  return (
    <div className="kl-modal-backdrop" onClick={onClose}>
      <div
        className="aa-acct-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Account"
      >
        <div className="aa-acct-hd">
          <h3>Account</h3>
          <button type="button" className="x" onClick={onClose} aria-label="Close">
            <Icons.X size={14} />
          </button>
        </div>

        <AccountPanel me={me} token={token} onAvatarChange={onAvatarChange} />
      </div>
    </div>
  );
}

export function AccountPanel({
  me,
  token,
  onAvatarChange,
}: {
  me: AuthMe;
  token: string;
  onAvatarChange: (avatar: string | null) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    setShowForm(false);
    setOldPw("");
    setNewPw("");
    setConfirmPw("");
    setError(null);
    setSuccess(false);
    setAvatarError(null);
  }, [me.userId]);

  const score = passwordScore(newPw);
  const mismatch = !!(newPw && confirmPw && newPw !== confirmPw);
  const tooShort = !!(newPw && newPw.length < 8);
  const sameAsOld = !!(newPw && oldPw && newPw === oldPw);
  const ok = !!(oldPw && newPw && confirmPw && !mismatch && !tooShort && !sameAsOld);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ok || loading) return;
    setError(null);
    setLoading(true);
    try {
      const { salt } = await api.passwordSalt(me.userId);
      await api.changePassword(token, {
        oldPasswordVerifier: await derivePasswordVerifier(oldPw, salt),
        ...(await createPasswordVerifier(newPw)),
      });
      setSuccess(true);
      window.setTimeout(() => {
        setShowForm(false);
        setSuccess(false);
        setOldPw("");
        setNewPw("");
        setConfirmPw("");
      }, 1100);
    } catch (err) {
      if (err instanceof ApiError) setError(err.detail);
      else setError("Something went wrong.");
    } finally {
      setLoading(false);
    }
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset the input so picking the same file twice in a row still fires onChange.
    e.target.value = "";
    if (!file) return;
    setAvatarError(null);
    setAvatarUploading(true);
    try {
      const dataUrl = await resizeToDataUrl(file, 256);
      const updated = await api.updateAvatar(token, { avatar: dataUrl });
      onAvatarChange(updated.avatar ?? null);
    } catch (err) {
      if (err instanceof ApiError) setAvatarError(err.detail);
      else setAvatarError(err instanceof Error ? err.message : "upload failed");
    } finally {
      setAvatarUploading(false);
    }
  };

  const handleClearAvatar = async () => {
    setAvatarError(null);
    setAvatarUploading(true);
    try {
      const updated = await api.clearAvatar(token);
      onAvatarChange(updated.avatar ?? null);
    } catch (err) {
      if (err instanceof ApiError) setAvatarError(err.detail);
      else setAvatarError(err instanceof Error ? err.message : "clear failed");
    } finally {
      setAvatarUploading(false);
    }
  };

  const msg = error
    ? { cls: "err", text: error }
    : success
      ? { cls: "ok", text: "Password updated." }
      : sameAsOld
        ? { cls: "err", text: "New password must differ from current" }
        : mismatch
          ? { cls: "err", text: "Passwords don't match" }
          : newPw
            ? { cls: "", text: STRENGTH_LABEL[score] }
            : null;

  const roleLabel = me.role === "admin" ? "Admin" : "Member";

  return (
        <div className="aa-acct-body">
          <div className="aa-acct-id">
            <div
              className="av"
              onClick={() => fileRef.current?.click()}
              title="Change avatar"
              role="button"
              tabIndex={0}
            >
              {me.avatar ? (
                <img className="avatar-img" src={me.avatar} alt="" />
              ) : (
                <Identicon id={me.userId} size={64} shape="rounded" />
              )}
              <div className="overlay">
                {avatarUploading ? (
                  <span className="spin" />
                ) : (
                  <>
                    <Icons.Pencil size={11} /> Change
                  </>
                )}
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                onChange={handleFile}
                style={{ display: "none" }}
              />
            </div>
            <div className="who">
              <span className="id">{me.userId}</span>
              <span className="role">{roleLabel}</span>
              {me.avatar && !avatarUploading && (
                <button
                  type="button"
                  className="aa-acct-btn ghost"
                  style={{ marginTop: 6, alignSelf: "flex-start", height: 24, fontSize: "var(--fs-xs)" }}
                  onClick={handleClearAvatar}
                >
                  Remove avatar
                </button>
              )}
            </div>
          </div>
          {avatarError && (
            <div className="aa-acct-msg err" style={{ marginTop: -8 }}>
              {avatarError}
            </div>
          )}

          <div className="aa-acct-kv">
            <span className="k">User ID</span>
            <span className="v">{me.userId}</span>
            <span className="k">Role</span>
            <span className="v">{roleLabel.toLowerCase()}</span>
          </div>

          {!showForm ? (
            <div className="aa-acct-cp-row">
              <div className="lbl">
                <span className="t">Password</span>
                <span className="s">Change the password used to sign in.</span>
              </div>
              <button
                type="button"
                className="aa-acct-btn"
                onClick={() => setShowForm(true)}
              >
                Change password
              </button>
            </div>
          ) : (
            <form onSubmit={submit} className="aa-acct-form">
              <div className="row">
                <label>Current password</label>
                <div className="field">
                  <input
                    type={showPw ? "text" : "password"}
                    value={oldPw}
                    onChange={(e) => setOldPw(e.target.value)}
                    autoComplete="current-password"
                    required
                    autoFocus
                  />
                  <button
                    type="button"
                    className="eye"
                    onClick={() => setShowPw((v) => !v)}
                    tabIndex={-1}
                    aria-label="Toggle password visibility"
                  >
                    {showPw ? <Icons.EyeOff size={13} /> : <Icons.Eye size={13} />}
                  </button>
                </div>
              </div>

              <div className="row">
                <label>New password</label>
                <div className="field">
                  <input
                    type={showPw ? "text" : "password"}
                    value={newPw}
                    onChange={(e) => setNewPw(e.target.value)}
                    placeholder="at least 8 characters"
                    autoComplete="new-password"
                    required
                  />
                </div>
                {newPw && (
                  <div className={`aa-acct-strength s${score}`}>
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

              <div className="row">
                <label>Confirm new password</label>
                <div className="field">
                  <input
                    type={showPw ? "text" : "password"}
                    value={confirmPw}
                    onChange={(e) => setConfirmPw(e.target.value)}
                    autoComplete="new-password"
                    required
                  />
                </div>
                {msg && msg.cls !== "" && newPw && (
                  <div className={`aa-acct-msg ${msg.cls}`}>{msg.text}</div>
                )}
              </div>

              <div className="aa-acct-actions">
                <button
                  type="button"
                  className="aa-acct-btn ghost"
                  onClick={() => {
                    setShowForm(false);
                    setOldPw("");
                    setNewPw("");
                    setConfirmPw("");
                    setError(null);
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="aa-acct-btn primary"
                  disabled={!ok || loading}
                >
                  {loading && <span className="spin" />}
                  {success ? "Saved" : loading ? "Saving" : "Update password"}
                </button>
              </div>
            </form>
          )}
        </div>
  );
}
