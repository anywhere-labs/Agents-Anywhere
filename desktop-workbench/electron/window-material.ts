import { release } from "node:os";
import type { BrowserWindowConstructorOptions } from "electron";

export function windowMaterial(platform = process.platform, osRelease = release()): "transparent" | "mica" | "opaque" {
  if (platform === "darwin") return "transparent";
  const build = /^(?:\d+\.){2}(\d+)(?:\.|$)/.exec(osRelease)?.[1];
  return platform === "win32" && build !== undefined && Number(build) >= 22621 ? "mica" : "opaque";
}

export function windowMaterialOptions(platform = process.platform, osRelease = release()): BrowserWindowConstructorOptions {
  const material = windowMaterial(platform, osRelease);
  if (material === "transparent") {
    return { transparent: true, backgroundColor: "#00000000", vibrancy: "sidebar", visualEffectState: "followWindow" };
  }
  if (material === "mica") return { backgroundColor: "#00000000", backgroundMaterial: "mica" };
  return { backgroundColor: "#171717" };
}
