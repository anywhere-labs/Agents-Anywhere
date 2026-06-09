import { useEffect, useRef } from "react";
import { Icons } from "../../components/Icons";
import { Identicon } from "../../components/Identicon";
import type { AuthMe } from "../../lib/api";

type UserMenuProps = {
  me: AuthMe;
  onClose: () => void;
  onOpenAccount: () => void;
  onOpenTeam: () => void;
  onOpenService: () => void;
  onLogout: () => void;
};

export function UserMenu({
  me,
  onClose,
  onOpenAccount,
  onOpenTeam,
  onOpenService,
  onLogout,
}: UserMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Defer so the click that opened the menu doesn't immediately close it.
    const handle = window.setTimeout(() => {
      document.addEventListener("mousedown", onDown);
      document.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      window.clearTimeout(handle);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const isAdmin = me.role === "admin";
  const roleLabel = isAdmin ? "Admin" : "Member";

  return (
    <div
      ref={ref}
      className="kl-row-menu"
      style={{
        position: "absolute",
        bottom: 52,
        left: 8,
        width: 244,
        padding: 6,
      }}
      role="menu"
    >
      <div className="aa-um-head">
        {me.avatar ? (
          <img className="avatar-img" src={me.avatar} alt="" />
        ) : (
          <Identicon id={me.userId} size={32} shape="rounded" />
        )}
        <div className="who">
          <span className="id">{me.userId}</span>
          <span className="role">{roleLabel}</span>
        </div>
      </div>

      <div
        className="item"
        onClick={() => {
          onClose();
          onOpenAccount();
        }}
      >
        <Icons.User size={13} /> Account
      </div>

      {isAdmin && (
        <div
          className="item"
          onClick={() => {
            onClose();
            onOpenTeam();
          }}
        >
          <Icons.Users size={13} /> Team
        </div>
      )}

      {isAdmin && (
        <div
          className="item"
          onClick={() => {
            onClose();
            onOpenService();
          }}
        >
          <Icons.Settings size={13} /> Service
        </div>
      )}

      <div className="sep" />

      <div
        className="item"
        onClick={() => {
          onClose();
          onLogout();
        }}
      >
        <Icons.Logout size={13} /> Sign out
      </div>
    </div>
  );
}
