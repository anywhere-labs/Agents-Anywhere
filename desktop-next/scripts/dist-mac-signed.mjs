import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const REQUIRED_ENV = [
  "MAC_CERT_P12_BASE64",
  "CSC_KEY_PASSWORD",
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
];

function envValue(key) {
  return process.env[key] ?? "";
}

function missingEnvKeys() {
  return REQUIRED_ENV.filter((key) => envValue(key).length === 0);
}

function writeP12FromEnv(certPath) {
  const clean = envValue("MAC_CERT_P12_BASE64").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/=]+$/.test(clean)) {
    throw new Error("MAC_CERT_P12_BASE64 is not valid base64 text");
  }
  const data = Buffer.from(clean, "base64");
  if (data.length === 0) {
    throw new Error("MAC_CERT_P12_BASE64 decoded to an empty file");
  }
  writeFileSync(certPath, data, { mode: 0o600 });
  chmodSync(certPath, 0o600);
}

function runYarnDist(env) {
  const command = process.platform === "win32" ? "yarn.cmd" : "yarn";
  return spawnSync(command, ["dist"], {
    stdio: "inherit",
    env,
  });
}

const missing = missingEnvKeys();
if (missing.length > 0) {
  console.error(`Missing required macOS signing environment variables: ${missing.join(", ")}`);
  console.error("Load them first, for example:");
  console.error("  set -a; source ../.local-notes/macos-signing-secrets.env; set +a");
  process.exit(1);
}

const tempDir = mkdtempSync(join(tmpdir(), "agents-anywhere-macos-sign-"));
const certPath = join(tempDir, "developer-id-application.p12");
let exitCode = 1;

try {
  writeP12FromEnv(certPath);
  const env = {
    ...process.env,
    CSC_LINK: certPath,
    CSC_KEY_PASSWORD: envValue("CSC_KEY_PASSWORD"),
    APPLE_ID: envValue("APPLE_ID"),
    APPLE_APP_SPECIFIC_PASSWORD: envValue("APPLE_APP_SPECIFIC_PASSWORD"),
    APPLE_TEAM_ID: envValue("APPLE_TEAM_ID"),
  };
  const result = runYarnDist(env);
  if (result.error) throw result.error;
  exitCode = typeof result.status === "number" ? result.status : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  exitCode = 1;
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

process.exit(exitCode);
