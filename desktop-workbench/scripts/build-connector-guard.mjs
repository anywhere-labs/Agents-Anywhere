import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (process.platform === "darwin") {
  const dist = fileURLToPath(new URL("../dist/", import.meta.url));
  mkdirSync(dist, { recursive: true });
  execFileSync("xcrun", [
    "clang", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
    "-mmacosx-version-min=13.0", "-arch", "arm64", "-arch", "x86_64",
    fileURLToPath(new URL("../native/connector-guard.c", import.meta.url)),
    "-o", fileURLToPath(new URL("../dist/connector-guard", import.meta.url)),
  ], { stdio: "inherit" });
}
