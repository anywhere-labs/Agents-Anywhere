import { useCallback, useEffect, useRef, useState } from "react";
import { Icons } from "../../components/Icons";
import { Identicon } from "../../components/Identicon";
import {
  ApiError,
  api,
  type AdminUser,
  type AuthMe,
  type UserRole,
} from "../../lib/api";
import { createPasswordVerifier } from "../../lib/passwordVerifier";
import { passwordScore, STRENGTH_LABEL, USER_ID_RE } from "../auth/password";

type TeamPageProps = {
  me: AuthMe;
  token: string;
  onBack: () => void;
};

type RoleFilter = "all" | "admin" | "member";

function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const now = new Date();
  const days = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (Number.isNaN(days)) return "—";
  if (days < 1) return "today";
  if (days < 2) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function TeamPage({ me, token, onBack }: TeamPageProps) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");

  const [rowMenu, setRowMenu] = useState<{ user: AdminUser; anchor: HTMLElement } | null>(
    null,
  );
  const [editUser, setEditUser] = useState<AdminUser | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteUser, setDeleteUser] = useState<AdminUser | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const body = await api.listUsers(token);
      setUsers(body.users);
    } catch (err) {
      if (err instanceof ApiError) setError(err.detail);
      else setError("Failed to load users.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const filtered = users.filter((u) => {
    if (roleFilter !== "all" && u.role !== roleFilter) return false;
    if (query && !u.userId.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  });

  const counts = {
    all: users.length,
    admin: users.filter((u) => u.role === "admin").length,
    member: users.filter((u) => u.role === "member").length,
  };

  return (
    <div className="aa-team" data-screen-label="04 Team">
      <div className="aa-team-body">
        <button type="button" className="aa-team-back-fixed" onClick={onBack}>
          <Icons.ChevRight size={14} style={{ transform: "rotate(180deg)" }} />
          Back
        </button>

        <div className="aa-team-inner">
          <div className="aa-team-h">
            <h1>Team</h1>
            <p>Manage who can sign in to this instance and what they can do.</p>
          </div>

          <div className="aa-team-tools">
            <div className="aa-team-search">
              <Icons.Search className="ico" size={14} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by user id"
              />
            </div>
            <div className="aa-team-seg">
              <button
                type="button"
                className={roleFilter === "all" ? "on" : ""}
                onClick={() => setRoleFilter("all")}
              >
                All <span style={{ color: "var(--text-faint)" }}>{counts.all}</span>
              </button>
              <button
                type="button"
                className={roleFilter === "admin" ? "on" : ""}
                onClick={() => setRoleFilter("admin")}
              >
                Admins <span style={{ color: "var(--text-faint)" }}>{counts.admin}</span>
              </button>
              <button
                type="button"
                className={roleFilter === "member" ? "on" : ""}
                onClick={() => setRoleFilter("member")}
              >
                Members <span style={{ color: "var(--text-faint)" }}>{counts.member}</span>
              </button>
            </div>
            <div style={{ flex: 1 }} />
            <button
              type="button"
              className="aa-team-btn"
              onClick={() => setCreateOpen(true)}
            >
              <Icons.Plus size={12} /> New user
            </button>
          </div>

          <div className="aa-team-tablewrap">
            <table className="aa-team-table">
              <thead>
                <tr>
                  <th>User</th>
                  <th style={{ width: 130 }}>Role</th>
                  <th style={{ width: 130 }}>Status</th>
                  <th style={{ width: 130 }}>Created</th>
                  <th style={{ width: 130 }}>Last updated</th>
                  <th className="aa-team-actcell"></th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={6} className="aa-team-empty">
                      Loading…
                    </td>
                  </tr>
                ) : error ? (
                  <tr>
                    <td colSpan={6} className="aa-team-empty">
                      {error}
                    </td>
                  </tr>
                ) : filtered.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="aa-team-empty">
                      No users match these filters.
                    </td>
                  </tr>
                ) : (
                  filtered.map((u) => {
                    const isSelf = u.userId === me.userId;
                    const isMenuOpen = rowMenu?.user.userId === u.userId;
                    return (
                      <tr
                        key={u.userId}
                        className={u.disabled ? "disabled" : ""}
                        onClick={() => setEditUser(u)}
                      >
                        <td>
                          <div className="aa-team-user">
                            {u.avatar ? (
                              <img className="avatar-img" src={u.avatar} alt="" />
                            ) : (
                              <Identicon id={u.userId} size={28} />
                            )}
                            <span className="id">{u.userId}</span>
                            {isSelf && <span className="aa-team-you">You</span>}
                          </div>
                        </td>
                        <td>
                          <span className={`aa-team-role ${u.role}`}>
                            <span className="dot" />
                            {u.role === "admin" ? "Admin" : "Member"}
                          </span>
                        </td>
                        <td>
                          <span
                            className={`aa-team-status ${u.disabled ? "disabled" : "active"}`}
                          >
                            <span className="dot" />
                            {u.disabled ? "Disabled" : "Active"}
                          </span>
                        </td>
                        <td>
                          <span className="aa-team-date">{fmtRelative(u.createdAt)}</span>
                        </td>
                        <td>
                          <span className="aa-team-date">{fmtRelative(u.updatedAt)}</span>
                        </td>
                        <td
                          className="aa-team-actcell"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            type="button"
                            className={`aa-team-more${isMenuOpen ? " open" : ""}`}
                            onClick={(e) =>
                              setRowMenu({ user: u, anchor: e.currentTarget })
                            }
                            aria-label="More actions"
                          >
                            <Icons.More size={14} />
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {rowMenu && (
        <TeamRowMenu
          anchor={rowMenu.anchor}
          user={rowMenu.user}
          isSelf={rowMenu.user.userId === me.userId}
          onClose={() => setRowMenu(null)}
          onEdit={() => setEditUser(rowMenu.user)}
          onToggleDisabled={async () => {
            try {
              const updated = await api.updateUser(token, rowMenu.user.userId, {
                disabled: !rowMenu.user.disabled,
              });
              setUsers((xs) =>
                xs.map((u) => (u.userId === updated.userId ? updated : u)),
              );
            } catch (err) {
              if (err instanceof ApiError) alert(err.detail);
            }
          }}
          onPromote={async () => {
            const next = rowMenu.user.role === "admin" ? "member" : "admin";
            try {
              const updated = await api.updateUser(token, rowMenu.user.userId, {
                role: next,
              });
              setUsers((xs) =>
                xs.map((u) => (u.userId === updated.userId ? updated : u)),
              );
            } catch (err) {
              if (err instanceof ApiError) alert(err.detail);
            }
          }}
          onDelete={() => setDeleteUser(rowMenu.user)}
        />
      )}

      {editUser && (
        <TeamEditModal
          user={editUser}
          isSelf={editUser.userId === me.userId}
          token={token}
          onClose={() => setEditUser(null)}
          onSaved={(updated) => {
            setUsers((xs) =>
              xs.map((u) => (u.userId === updated.userId ? updated : u)),
            );
            setEditUser(null);
          }}
          onDeleteRequested={() => {
            setDeleteUser(editUser);
            setEditUser(null);
          }}
        />
      )}

      {createOpen && (
        <TeamCreateModal
          token={token}
          onClose={() => setCreateOpen(false)}
          onCreated={(u) => {
            setUsers((xs) => [u, ...xs]);
            setCreateOpen(false);
          }}
        />
      )}

      {deleteUser && (
        <TeamDeleteModal
          user={deleteUser}
          token={token}
          onClose={() => setDeleteUser(null)}
          onDeleted={() => {
            setUsers((xs) => xs.filter((u) => u.userId !== deleteUser.userId));
            setDeleteUser(null);
          }}
        />
      )}
    </div>
  );
}

// ─── Row menu ────────────────────────────────────────────────────────────

type TeamRowMenuProps = {
  anchor: HTMLElement;
  user: AdminUser;
  isSelf: boolean;
  onClose: () => void;
  onEdit: () => void;
  onToggleDisabled: () => void;
  onPromote: () => void;
  onDelete: () => void;
};

function TeamRowMenu({
  anchor,
  user,
  isSelf,
  onClose,
  onEdit,
  onToggleDisabled,
  onPromote,
  onDelete,
}: TeamRowMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const handle = window.setTimeout(
      () => document.addEventListener("mousedown", close),
      0,
    );
    return () => {
      window.clearTimeout(handle);
      document.removeEventListener("mousedown", close);
    };
  }, [onClose]);

  const rect = anchor.getBoundingClientRect();
  const W = 200;
  const top = Math.min(window.innerHeight - 240, rect.bottom + 4);
  const left = Math.min(window.innerWidth - W - 8, rect.right - W);

  return (
    <div ref={ref} className="aa-team-menu" style={{ top, left, width: W }}>
      <div
        className="item"
        onClick={() => {
          onClose();
          onEdit();
        }}
      >
        <Icons.Pencil size={13} /> Edit user
      </div>
      <div
        className={`item${isSelf ? " disabled" : ""}`}
        onClick={() => {
          if (isSelf) return;
          onClose();
          onToggleDisabled();
        }}
      >
        {user.disabled ? <Icons.Unlock size={13} /> : <Icons.Slash size={13} />}
        {user.disabled ? "Enable" : "Disable"}
      </div>
      <div
        className={`item${isSelf ? " disabled" : ""}`}
        onClick={() => {
          if (isSelf) return;
          onClose();
          onPromote();
        }}
      >
        <Icons.Shield size={13} />
        {user.role === "admin" ? "Demote to member" : "Promote to admin"}
      </div>
      <div className="sep" />
      <div
        className={`item danger${isSelf ? " disabled" : ""}`}
        onClick={() => {
          if (isSelf) return;
          onClose();
          onDelete();
        }}
      >
        <Icons.Trash size={13} /> Delete user
      </div>
    </div>
  );
}

// ─── Edit modal ──────────────────────────────────────────────────────────

type TeamEditModalProps = {
  user: AdminUser;
  isSelf: boolean;
  token: string;
  onClose: () => void;
  onSaved: (u: AdminUser) => void;
  onDeleteRequested: () => void;
};

function TeamEditModal({
  user,
  isSelf,
  token,
  onClose,
  onSaved,
  onDeleteRequested,
}: TeamEditModalProps) {
  const [role, setRole] = useState<UserRole>(user.role);
  const [disabled, setDisabled] = useState<boolean>(user.disabled);
  const [pwOpen, setPwOpen] = useState(false);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tooShort = !!(pw && pw.length < 8);
  const mismatch = !!(pw && pw2 && pw !== pw2);
  const pwOk = !!(pw && pw2 && !tooShort && !mismatch);
  const score = passwordScore(pw);
  const dirty = role !== user.role || disabled !== user.disabled;

  const handleSave = async () => {
    if (!dirty || saving) return;
    setError(null);
    setSaving(true);
    try {
      const patch: { role?: UserRole; disabled?: boolean } = {};
      if (role !== user.role) patch.role = role;
      if (disabled !== user.disabled) patch.disabled = disabled;
      const updated = await api.updateUser(token, user.userId, patch);
      onSaved(updated);
    } catch (err) {
      if (err instanceof ApiError) setError(err.detail);
      else setError("Save failed.");
    } finally {
      setSaving(false);
    }
  };

  const handleSetPassword = async () => {
    if (!pwOk || saving) return;
    setError(null);
    setSaving(true);
    try {
      const updated = await api.updateUser(token, user.userId, {
        ...(await createPasswordVerifier(pw)),
      });
      onSaved(updated);
      setPwOpen(false);
      setPw("");
      setPw2("");
    } catch (err) {
      if (err instanceof ApiError) setError(err.detail);
      else setError("Reset failed.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="kl-modal-backdrop" onClick={onClose}>
      <div
        className="aa-team-edit"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Edit user"
      >
        <div className="hd">
          <h3>Edit user</h3>
          <button type="button" className="x" onClick={onClose} aria-label="Close">
            <Icons.X size={14} />
          </button>
        </div>

        <div className="body">
          <div className="ident">
            {user.avatar ? (
              <img className="avatar-img" src={user.avatar} alt="" />
            ) : (
              <Identicon id={user.userId} size={48} shape="rounded" />
            )}
            <div className="who">
              <span className="id">
                {user.userId}
                {isSelf && (
                  <span className="aa-team-you" style={{ marginLeft: 8 }}>
                    You
                  </span>
                )}
              </span>
              <span className="meta">
                Created{" "}
                {new Date(user.createdAt).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}{" "}
                · <code>{user.userId}</code>
              </span>
            </div>
          </div>

          <div className="grid">
            <label>
              Role
              <small>
                {role === "admin"
                  ? "Can manage users and service settings."
                  : "Standard member."}
              </small>
            </label>
            <div className="aa-team-seg" style={{ alignSelf: "start", height: 30 }}>
              <button
                type="button"
                className={role === "member" ? "on" : ""}
                onClick={() => !isSelf && setRole("member")}
                disabled={isSelf}
              >
                Member
              </button>
              <button
                type="button"
                className={role === "admin" ? "on" : ""}
                onClick={() => !isSelf && setRole("admin")}
                disabled={isSelf}
              >
                Admin
              </button>
            </div>

            <label>
              Status
              <small>
                {disabled ? "Sign-in is blocked." : "Can sign in normally."}
              </small>
            </label>
            <label
              className="aa-team-switch"
              style={{ justifySelf: "start" }}
              title={isSelf ? "Can't disable yourself" : ""}
            >
              <input
                type="checkbox"
                checked={!disabled}
                disabled={isSelf}
                onChange={(e) => setDisabled(!e.target.checked)}
              />
              <span className="track" />
              <span className="knob" />
            </label>

            <label>
              Password
              <small>Set a new password for this user.</small>
            </label>
            {!pwOpen ? (
              <button
                type="button"
                className="aa-team-btn ghost"
                style={{ justifySelf: "start" }}
                onClick={() => setPwOpen(true)}
              >
                <Icons.Key size={12} /> Reset password
              </button>
            ) : (
              <div className="pwsub" style={{ gridColumn: "1 / -1" }}>
                <div className="row">
                  <label>New password</label>
                  <div className="field">
                    <input
                      type={showPw ? "text" : "password"}
                      value={pw}
                      onChange={(e) => setPw(e.target.value)}
                      placeholder="at least 8 characters"
                      autoFocus
                    />
                    <button
                      type="button"
                      className="eye"
                      tabIndex={-1}
                      onClick={() => setShowPw((v) => !v)}
                    >
                      {showPw ? <Icons.EyeOff size={13} /> : <Icons.Eye size={13} />}
                    </button>
                  </div>
                  {pw && (
                    <div
                      className={`aa-acct-strength s${score}`}
                      style={{ marginTop: 2 }}
                    >
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
                  <label>Confirm</label>
                  <div className="field">
                    <input
                      type={showPw ? "text" : "password"}
                      value={pw2}
                      onChange={(e) => setPw2(e.target.value)}
                    />
                  </div>
                  {mismatch && (
                    <div className="aa-acct-msg err">Passwords don't match</div>
                  )}
                </div>
                <div className="actrow">
                  <button
                    type="button"
                    className="aa-team-btn ghost"
                    onClick={() => {
                      setPwOpen(false);
                      setPw("");
                      setPw2("");
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="aa-team-btn"
                    disabled={!pwOk || saving}
                    onClick={handleSetPassword}
                  >
                    Set password
                  </button>
                </div>
              </div>
            )}
          </div>

          {error && <div className="aa-acct-msg err">{error}</div>}
        </div>

        <div className="ft">
          <button
            type="button"
            className="aa-team-btn danger"
            disabled={isSelf}
            onClick={onDeleteRequested}
          >
            <Icons.Trash size={12} /> Delete user
          </button>
          <span className="hint"></span>
          <button type="button" className="aa-team-btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="aa-team-btn"
            disabled={!dirty || saving}
            onClick={handleSave}
          >
            Save changes
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Create modal ────────────────────────────────────────────────────────

type TeamCreateModalProps = {
  token: string;
  onClose: () => void;
  onCreated: (u: AdminUser) => void;
};

function TeamCreateModal({ token, onClose, onCreated }: TeamCreateModalProps) {
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<UserRole>("member");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const idValid = USER_ID_RE.test(userId);
  const tooShort = !!(pw && pw.length < 8);
  const mismatch = !!(pw && pw2 && pw !== pw2);
  const ok = !!(idValid && pw && pw2 && !tooShort && !mismatch);
  const score = passwordScore(pw);

  const handleCreate = async () => {
    if (!ok || saving) return;
    setError(null);
    setSaving(true);
    try {
      const created = await api.createUser(token, {
        userId,
        role,
        ...(await createPasswordVerifier(pw)),
      });
      onCreated(created);
    } catch (err) {
      if (err instanceof ApiError) setError(err.detail);
      else setError("Create failed.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="kl-modal-backdrop" onClick={onClose}>
      <div
        className="aa-team-create"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="New user"
      >
        <div className="hd">
          <h3>New user</h3>
          <button type="button" className="x" onClick={onClose} aria-label="Close">
            <Icons.X size={14} />
          </button>
        </div>

        <div className="body">
          <div className="row">
            <label>User ID</label>
            <input
              value={userId}
              onChange={(e) =>
                setUserId(e.target.value.replace(/[^a-zA-Z0-9_-]/g, "").toLowerCase())
              }
              placeholder="e.g. kenji"
              autoFocus
              style={{ fontFamily: "var(--mono)" }}
            />
          </div>

          <div className="row">
            <label>Role</label>
            <div className="aa-team-seg" style={{ alignSelf: "start", height: 32 }}>
              <button
                type="button"
                className={role === "member" ? "on" : ""}
                onClick={() => setRole("member")}
              >
                Member
              </button>
              <button
                type="button"
                className={role === "admin" ? "on" : ""}
                onClick={() => setRole("admin")}
              >
                Admin
              </button>
            </div>
          </div>

          <div className="row">
            <label>Password</label>
            <div className="field-wrap">
              <input
                type={showPw ? "text" : "password"}
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                placeholder="at least 8 characters"
              />
              <button
                type="button"
                className="eye"
                tabIndex={-1}
                onClick={() => setShowPw((v) => !v)}
              >
                {showPw ? <Icons.EyeOff size={13} /> : <Icons.Eye size={13} />}
              </button>
            </div>
            {pw && (
              <div
                className={`aa-acct-strength s${score}`}
                style={{ marginTop: 2 }}
              >
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
            <label>Confirm</label>
            <input
              type={showPw ? "text" : "password"}
              value={pw2}
              onChange={(e) => setPw2(e.target.value)}
            />
            {mismatch && (
              <div className="aa-acct-msg err" style={{ marginTop: 2 }}>
                Passwords don't match
              </div>
            )}
          </div>

          {error && <div className="aa-acct-msg err">{error}</div>}
        </div>

        <div className="ft">
          <span className="hint">They can change this after first sign-in.</span>
          <button type="button" className="aa-team-btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="aa-team-btn"
            disabled={!ok || saving}
            onClick={handleCreate}
          >
            Create user
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Delete confirm ──────────────────────────────────────────────────────

type TeamDeleteModalProps = {
  user: AdminUser;
  token: string;
  onClose: () => void;
  onDeleted: () => void;
};

function TeamDeleteModal({ user, token, onClose, onDeleted }: TeamDeleteModalProps) {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ok = text === user.userId;

  const handleDelete = async () => {
    if (!ok || saving) return;
    setError(null);
    setSaving(true);
    try {
      await api.deleteUser(token, user.userId);
      onDeleted();
    } catch (err) {
      if (err instanceof ApiError) setError(err.detail);
      else setError("Delete failed.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="kl-modal-backdrop" onClick={onClose}>
      <div
        className="aa-team-confirm"
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
      >
        <div className="hd">
          <h3>Delete user</h3>
          <button type="button" className="x" onClick={onClose} aria-label="Close">
            <Icons.X size={14} />
          </button>
        </div>

        <div className="body">
          <p>
            This permanently removes <code>{user.userId}</code> from this instance.
            Their access tokens stop working immediately.
          </p>
          <p>
            <span className="muted">Type the user id to confirm:</span>
          </p>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoFocus
          />
          {error && <div className="aa-acct-msg err">{error}</div>}
        </div>

        <div className="ft">
          <button type="button" className="aa-team-btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="aa-team-btn danger"
            disabled={!ok || saving}
            onClick={handleDelete}
          >
            <Icons.Trash size={12} /> Delete user
          </button>
        </div>
      </div>
    </div>
  );
}
