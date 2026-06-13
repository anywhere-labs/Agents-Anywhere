import type { ReactNode } from "react";
import { Icons } from "../../components/Icons";
import type { Theme } from "../../lib/theme";

type AuthChromeProps = {
  theme: Theme;
  onSetTheme: (theme: Theme) => void;
  serverUrl: string;
  children: ReactNode;
};

export function AuthChrome({
  theme,
  onSetTheme,
  serverUrl,
  children,
}: AuthChromeProps) {
  return (
    <div className="aa-auth">
      <div className="aa-auth-top">
        <div className="left">
          <span className="aa-top-word">Agents Anywhere</span>
        </div>
        <div className="right">
          <a
            href="https://github.com/anywhere-labs/Agents-Anywhere"
            target="_blank"
            rel="noreferrer"
          >
            GitHub
          </a>
          <a href="#docs">Docs</a>
          <div className="theme-seg" role="group" aria-label="Color theme">
            <button
              type="button"
              className={theme === "light" ? "on" : ""}
              onClick={() => onSetTheme("light")}
              aria-label="Light mode"
              title="Light mode"
            >
              <Icons.Sun size={13} />
            </button>
            <button
              type="button"
              className={theme === "dark" ? "on" : ""}
              onClick={() => onSetTheme("dark")}
              aria-label="Dark mode"
              title="Dark mode"
            >
              <Icons.Moon size={13} />
            </button>
          </div>
        </div>
      </div>

      <div className="aa-auth-body">{children}</div>

      <div className="aa-auth-bottom">
        <div className="left">
          <span className="aa-server-chip">
            <span className="pulse" />
            <code>{serverUrl}</code>
          </span>
        </div>
      </div>
    </div>
  );
}
