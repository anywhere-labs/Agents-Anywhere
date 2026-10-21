/**
 * Records the Server version this Desktop build targets. Update checks compare
 * the live Server `/health` version against this baseline, so Desktop and Server
 * PATCH numbers may differ without triggering a false update prompt.
 */
import { readFileSync, writeFileSync } from "node:fs";

const pyproject = readFileSync(new URL("../../server/pyproject.toml", import.meta.url), "utf8");
const project = /^\[project\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(pyproject)?.[1] ?? "";
const serverVersion = /^version\s*=\s*"([^"]+)"\s*$/m.exec(project)?.[1];
if (!serverVersion) throw new Error("server/pyproject.toml has no [project] version.");

writeFileSync(new URL("../build-info.json", import.meta.url), `${JSON.stringify({ serverVersion }, null, 2)}\n`);
