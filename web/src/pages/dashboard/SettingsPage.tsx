import { Icons } from "../../components/Icons";
import type { AuthMe } from "../../lib/api";
import type { Theme } from "../../lib/theme";
import { AccountPanel } from "./AccountModal";

type SettingsPageProps = {
  me: AuthMe;
  token: string;
  theme: Theme;
  onSetTheme: (theme: Theme) => void;
  onAvatarChange: (avatar: string | null) => void;
  onBack: () => void;
};

const THEME_OPTIONS: Array<{
  value: Theme;
  title: string;
  subtitle: string;
  image: string;
}> = [
  {
    value: "light",
    title: "Light",
    subtitle: "Bright interface",
    image: "https://chat.t4wefan.pub/images/theme_light.webp",
  },
  {
    value: "dark",
    title: "Dark",
    subtitle: "Dim interface",
    image: "https://chat.t4wefan.pub/images/theme_dark.webp",
  },
  {
    value: "auto",
    title: "Auto",
    subtitle: "Follow system",
    image: "https://chat.t4wefan.pub/images/theme_auto.webp",
  },
];

export function SettingsPage({
  me,
  token,
  theme,
  onSetTheme,
  onAvatarChange,
  onBack,
}: SettingsPageProps) {
  return (
    <div className="aa-srv aa-settings" data-screen-label="Settings">
      <div className="aa-srv-body">
        <button type="button" className="aa-srv-back-fixed" onClick={onBack}>
          <Icons.ChevRight size={14} style={{ transform: "rotate(180deg)" }} />
          Back
        </button>

        <div className="aa-srv-inner">
          <div className="aa-srv-h">
            <h1>Settings</h1>
            <p>Appearance and account preferences for this browser.</p>
          </div>

          <div className="aa-srv-card">
            <div className="hd">
              <h3>Appearance</h3>
            </div>
            <div className="body aa-settings-appearance">
              <div className="aa-theme-grid" role="radiogroup" aria-label="Color theme">
                {THEME_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={"aa-theme-card" + (theme === option.value ? " on" : "")}
                    onClick={() => onSetTheme(option.value)}
                    role="radio"
                    aria-checked={theme === option.value}
                  >
                    <span className="aa-theme-card-head">
                      <strong>{option.title}</strong>
                      <span className="aa-theme-radio" />
                    </span>
                    <span className="aa-theme-preview">
                      <img src={option.image} alt="" loading="lazy" />
                    </span>
                    <span className="aa-theme-card-subtitle">{option.subtitle}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="aa-srv-card aa-settings-account">
            <div className="hd">
              <h3>Account</h3>
            </div>
            <AccountPanel me={me} token={token} onAvatarChange={onAvatarChange} />
          </div>
        </div>
      </div>
    </div>
  );
}
