import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const NOTARY_KEYCHAIN_PROFILE = "agents-anywhere-notary";

const REQUIRED_ENV = [
  "MAC_CERT_P12_BASE64",
  "CSC_KEY_PASSWORD",
  "MACOS_SIGN_IDENTITY",
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

function signingNameQualifier() {
  return envValue("MACOS_SIGN_IDENTITY").replace(/^Developer ID Application:\s*/i, "").trim();
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

function runSecurity(args, options = {}) {
  const result = spawnSync("/usr/bin/security", args, {
    stdio: options.stdio ?? "pipe",
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`security ${args[0]} failed${output ? `:\n${output}` : ""}`);
  }
  return result.stdout;
}

function runNotaryTool(args, options = {}) {
  const result = spawnSync("/usr/bin/xcrun", ["notarytool", ...args], {
    stdio: options.stdio ?? "pipe",
    encoding: "utf8",
    input: options.input,
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`notarytool ${args[0]} failed${output ? `:\n${output}` : ""}`);
  }
  return result.stdout;
}

function tryDeleteKeychain(keychainPath) {
  spawnSync("/usr/bin/security", ["delete-keychain", keychainPath], {
    stdio: "ignore",
  });
}

function setupKeychain(keychainPath, keychainPassword, certPath) {
  runSecurity(["create-keychain", "-p", keychainPassword, keychainPath]);
  runSecurity(["set-keychain-settings", "-lut", "21600", keychainPath]);
  runSecurity(["unlock-keychain", "-p", keychainPassword, keychainPath]);
  runSecurity(["import", certPath, "-P", envValue("CSC_KEY_PASSWORD"), "-A", "-t", "cert", "-f", "pkcs12", "-k", keychainPath]);
  runSecurity(["set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", keychainPassword, keychainPath]);
}

function setupNotaryProfile(keychainPath) {
  runNotaryTool(
    [
      "store-credentials",
      NOTARY_KEYCHAIN_PROFILE,
      "--apple-id",
      envValue("APPLE_ID"),
      "--team-id",
      envValue("APPLE_TEAM_ID"),
      "--keychain",
      keychainPath,
      "--validate",
    ],
    { input: `${envValue("APPLE_APP_SPECIFIC_PASSWORD")}\n` },
  );
}

function macosReleaseOutputDir() {
  const value = envValue("MACOS_RELEASE_OUTPUT_DIR").trim();
  if (value.length === 0) return "";
  if (value.startsWith("/") || value.includes("\0") || value.includes("..")) {
    throw new Error("MACOS_RELEASE_OUTPUT_DIR must be a simple relative output directory");
  }
  return value;
}

function runYarn(args, env) {
  const command = process.platform === "win32" ? "yarn.cmd" : "yarn";
  return spawnSync(command, args, {
    stdio: "inherit",
    env,
  });
}

function runYarnChecked(args, env) {
  const result = runYarn(args, env);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`yarn ${args.join(" ")} exited with ${result.status}`);
  }
}

function runYarnDist(env) {
  const outputDir = macosReleaseOutputDir();
  if (!outputDir) return runYarn(["dist"], env);

  runYarnChecked(["bundle:uv"], env);
  runYarnChecked(["build"], env);
  return runYarn(["electron-builder", `-c.directories.output=${outputDir}`], env);
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
const keychainPath = join(tempDir, "agents-anywhere-signing.keychain-db");
const keychainPassword = randomBytes(24).toString("hex");
let exitCode = 1;

try {
  writeP12FromEnv(certPath);
  setupKeychain(keychainPath, keychainPassword, certPath);
  setupNotaryProfile(keychainPath);
  const env = {
    ...process.env,
    CSC_KEYCHAIN: keychainPath,
    CSC_NAME: signingNameQualifier(),
    APPLE_KEYCHAIN: keychainPath,
    APPLE_KEYCHAIN_PROFILE: NOTARY_KEYCHAIN_PROFILE,
  };
  delete env.CSC_LINK;
  delete env.APPLE_ID;
  delete env.APPLE_APP_SPECIFIC_PASSWORD;
  delete env.APPLE_TEAM_ID;
  delete env.APPLE_API_KEY;
  delete env.APPLE_API_KEY_ID;
  delete env.APPLE_API_ISSUER;
  const result = runYarnDist(env);
  if (result.error) throw result.error;
  exitCode = typeof result.status === "number" ? result.status : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  exitCode = 1;
} finally {
  tryDeleteKeychain(keychainPath);
  rmSync(tempDir, { recursive: true, force: true });
}

process.exit(exitCode);
