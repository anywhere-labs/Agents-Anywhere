import { useCallback, useEffect, useState } from "react";
import { AuthPage } from "./pages/auth/AuthPage";
import { SessionsPage } from "./pages/dashboard/SessionsPage";
import { SessionDetailPage } from "./pages/dashboard/session-detail/SessionDetailPage";
import {
  clearSession,
  loadSession,
  saveSession,
  type StoredSession,
} from "./lib/session";
import { ApiError, api, type AuthMe, type AuthResponse } from "./lib/api";
import { useTheme } from "./lib/theme";

type AuthState =
  | { kind: "checking" }
  | { kind: "auth" }
  | { kind: "ready"; session: StoredSession; me: AuthMe };

export default function App() {
  const [theme, setTheme] = useTheme();

  // URL-driven entry point for the runtime-panel demo. Real dashboard
  // navigation uses HashRouter paths such as #/sessions/:id and #/devices/:id.
  const url = new URL(window.location.href);
  const demoRuntime = url.searchParams.get("demo") === "runtime";

  const [state, setState] = useState<AuthState>(() => {
    const session = loadSession();
    return session ? { kind: "checking" } : { kind: "auth" };
  });

  // On mount, if there is a stored token, validate it via /auth/me. A 401
  // means the token expired or the account was deleted/disabled — punt to the
  // auth screen. Any other failure also falls through to auth so the user
  // can re-enter credentials manually.
  useEffect(() => {
    if (state.kind !== "checking") return;
    const session = loadSession();
    if (!session) {
      setState({ kind: "auth" });
      return;
    }
    let cancelled = false;
    api
      .me(session.accessToken)
      .then((me) => {
        if (cancelled) return;
        setState({ kind: "ready", session, me });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          clearSession();
        }
        setState({ kind: "auth" });
      });
    return () => {
      cancelled = true;
    };
  }, [state.kind]);

  const handleAuthed = (auth: AuthResponse) => {
    const session: StoredSession = {
      accessToken: auth.accessToken,
      userId: auth.userId,
      role: auth.role,
    };
    saveSession(session);
    // Pull the full /auth/me so the next screen has the avatar in hand
    // before its first render. Fall back to a minimal stub if it fails —
    // gating still runs and downstream pages have their own retries.
    api
      .me(auth.accessToken)
      .then((me) => setState({ kind: "ready", session, me }))
      .catch(() =>
        setState({
          kind: "ready",
          session,
          me: {
            userId: auth.userId,
            role: auth.role,
            disabled: false,
            avatar: null,
            serverTime: auth.serverTime,
          },
        }),
      );
  };

  const handleSignOut = useCallback(() => {
    clearSession();
    setState({ kind: "auth" });
  }, []);

  // Demo runtime panel works without any auth — the entire fs/terminal
  // layer is served by the in-component DEMO_TREE fixtures.
  if (demoRuntime) {
    return (
      <SessionDetailPage
        sessionId="demo"
        sessionTitle="Demo: Files / Terminal panels"
        token={null}
        demo
        onBack={() => {
          url.searchParams.delete("demo");
          window.history.replaceState({}, "", url.toString());
          window.location.reload();
        }}
      />
    );
  }

  if (state.kind === "checking") {
    return (
      <div className="aa-boot">
        <span className="spin" />
        <span>Restoring session</span>
      </div>
    );
  }

  if (state.kind === "ready") {
    return (
      <SessionsPage
        token={state.session.accessToken}
        initialMe={state.me}
        theme={theme}
        onSetTheme={setTheme}
        onSignOut={handleSignOut}
      />
    );
  }

  return (
    <AuthPage
      theme={theme}
      onSetTheme={setTheme}
      onAuthed={handleAuthed}
    />
  );
}
