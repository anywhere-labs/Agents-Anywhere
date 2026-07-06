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

assert.match(mainSource, /function connectorRuntimeDir\(\)[\s\S]*userDataPath\("connector-runtime"\)/, "packaged connector runtime cwd must be under userData");
assert.match(mainSource, /function bundledConnectorDir\(\)[\s\S]*process\.resourcesPath,\s*"connector"/, "packaged connector source must be read from resources");
assert.match(mainSource, /function connectorRuntimeProjectDir\(\)[\s\S]*path\.join\(connectorRuntimeDir\(\),\s*"connector"\)/, "packaged connector project must live under userData");
assert.match(mainSource, /function connectorWorkingDir\(\)[\s\S]*app\.isPackaged \? connectorRuntimeDir\(\) : state\.connectorDir/, "packaged connector cwd must use userData while dev keeps source cwd");
assert.match(mainSource, /function resolveConnectorDir\(\)[\s\S]*if \(app\.isPackaged\) return connectorRuntimeProjectDir\(\)/, "packaged connector project must not point into the signed app bundle");
assert.match(mainSource, /fs\.cpSync\(bundledConnectorDir\(\), connectorRuntimeProjectDir\(\)/, "packaged connector source must be copied to a writable runtime project");
assert.match(mainSource, /UV_PROJECT_ENVIRONMENT:\s*connectorUvEnvironmentPath\(\)/, "uv virtualenv must be outside the signed app bundle");
assert.match(mainSource, /UV_CACHE_DIR:\s*connectorUvCacheDir\(\)/, "uv cache must be outside the signed app bundle");
assert.match(mainSource, /cwd:\s*connectorWorkingDir\(\)/, "connector RPC cwd must not be the bundled resource directory");
assert.doesNotMatch(mainSource, /cwd:\s*state\.connectorDir/, "connector RPC must not use the signed connector resource as cwd");
assert.doesNotMatch(mainSource, /"--locked"/, "packaged uv run must not require a lockfile that is not bundled");

console.log("macos release signing config ok");
