/**
 * Records the Server version this Desktop build targets. Update checks compare
 * the live Server `/health` version against this baseline, so Desktop and Server
 * PATCH numbers may differ without triggering a false update prompt.
 *
 * It also bakes the per-platform installer download URLs chosen at build time.
 * The live Server deliberately does not supply the download address (a
 * server-controlled URL would let any tenant point clients at arbitrary bytes);
 * instead each release build stamps the trusted addresses for its artifacts.
 * Set one or more of WORKBENCH_UPDATE_URL_DARWIN / _WIN32 / _LINUX. A platform
 * with no stamped URL simply reports "update not configured" and skips download.
 */
import { readFileSync, writeFileSync } from "node:fs";

const pyproject = readFileSync(new URL("../../server/pyproject.toml", import.meta.url), "utf8");
const project = /^\[project\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(pyproject)?.[1] ?? "";
const serverVersion = /^version\s*=\s*"([^"]+)"\s*$/m.exec(project)?.[1];
if (!serverVersion) throw new Error("server/pyproject.toml has no [project] version.");

const env = process.env;
const updates = {};
for (const [platform, variable] of [["darwin", "WORKBENCH_UPDATE_URL_DARWIN"], ["win32", "WORKBENCH_UPDATE_URL_WIN32"], ["linux", "WORKBENCH_UPDATE_URL_LINUX"]]) {
  const value = (env[variable] ?? "").trim();
  if (value) updates[platform] = value;
}

writeFileSync(new URL("../build-info.json", import.meta.url), `${JSON.stringify({ serverVersion, updates }, null, 2)}\n`);
