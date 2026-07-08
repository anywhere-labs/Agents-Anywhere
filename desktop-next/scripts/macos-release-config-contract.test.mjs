import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectDir = join(scriptDir, "..");

const packageJson = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8"));
const mac = packageJson.build?.mac ?? {};

assert.equal(mac.hardenedRuntime, true, "macOS release builds must enable hardenedRuntime");
assert.notEqual(mac.identity, "-", "macOS release builds must not force ad-hoc signing");
assert.equal(mac.entitlements, "build/entitlements.mac.plist");
assert.equal(mac.entitlementsInherit, "build/entitlements.mac.plist");

const entitlements = readFileSync(join(projectDir, "build/entitlements.mac.plist"), "utf8");

for (const key of [
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.cs.disable-library-validation",
]) {
  assert.match(entitlements, new RegExp(`<key>${key}</key>\\s*<true/>`), `missing ${key}`);
}

const mainSource = readFileSync(join(projectDir, "electron/main.cjs"), "utf8");

assert.match(mainSource, /function resolveConnectorDir\(\)[\s\S]*if \(app\.isPackaged\) return path\.join\(process\.resourcesPath,\s*"connector"\)/, "packaged connector source must stay in app resources");
assert.match(mainSource, /cwd:\s*state\.connectorDir/, "connector RPC should run from the packaged connector resource");
assert.doesNotMatch(mainSource, /connectorRuntimeDir/, "packaged connector runtime must not be copied to userData");
assert.doesNotMatch(mainSource, /connectorRuntimeProjectDir/, "packaged connector runtime must not be copied to userData");
assert.doesNotMatch(mainSource, /ensureConnectorRuntimeDirs/, "packaged connector runtime must not be copied to userData");
assert.doesNotMatch(mainSource, /UV_PROJECT_ENVIRONMENT:\s*connectorUvEnvironmentPath\(\)/, "uv virtualenv must not be redirected to userData by this release contract");
assert.doesNotMatch(mainSource, /UV_CACHE_DIR:\s*connectorUvCacheDir\(\)/, "uv cache must not be redirected to userData by this release contract");
assert.doesNotMatch(mainSource, /"--locked"/, "packaged uv run must not require a lockfile that is not bundled");

console.log("macos release signing config ok");
