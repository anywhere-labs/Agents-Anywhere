import type { CSSProperties } from "react";
import logoDarkMode from "../assets/brand/aa-logo-dark-mode.png";
import logoLightMode from "../assets/brand/aa-logo-light-mode.png";

type BrandLogoProps = {
  size?: number;
  className?: string;
};

export function BrandLogo({ size = 24, className }: BrandLogoProps) {
  const style = { "--aa-logo-size": `${size}px` } as CSSProperties;
  return (
    <span className={["aa-logo", className].filter(Boolean).join(" ")} style={style} aria-hidden="true">
      <img className="aa-logo-img aa-logo-dark-mode" src={logoDarkMode} alt="" draggable={false} />
      <img className="aa-logo-img aa-logo-light-mode" src={logoLightMode} alt="" draggable={false} />
    </span>
  );
}
