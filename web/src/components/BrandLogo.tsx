import type { CSSProperties } from "react";
import iconDarkMode from "../assets/brand/icon-light.svg";
import iconLightMode from "../assets/brand/icon-dark.svg";

type BrandLogoProps = {
  size?: number;
  padding?: number;
  className?: string;
};

export function BrandLogo({ size = 24, padding = 0.14, className }: BrandLogoProps) {
  const style = {
    "--aa-logo-size": `${size}px`,
    "--aa-logo-padding": `${Math.max(0, Math.min(padding, 0.4)) * 100}%`,
  } as CSSProperties;
  return (
    <span className={["aa-logo", className].filter(Boolean).join(" ")} style={style} aria-hidden="true">
      <img className="aa-logo-img aa-logo-dark-mode" src={iconDarkMode} alt="" draggable={false} />
      <img className="aa-logo-img aa-logo-light-mode" src={iconLightMode} alt="" draggable={false} />
    </span>
  );
}
