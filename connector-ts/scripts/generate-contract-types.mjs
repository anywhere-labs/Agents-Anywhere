// Generate TypeScript types for the v3 contracts consumed by the Connector.
//
// Source of truth: Pydantic models in server/agent_server/core, exported to
// contracts/<name>/<version>/ by server/scripts/export_v3_contracts.py. This
// script verifies each schema against its manifest checksum and compiles it
// into src/generated/<name>/v<major>_<minor>/<slug>.ts.
//
//   node scripts/generate-contract-types.mjs          # write
//   node scripts/generate-contract-types.mjs --check  # fail when stale
import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { compileFromFile } from "json-schema-to-typescript"

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const repositoryRoot = path.resolve(packageRoot, "..")
const checkOnly = process.argv.includes("--check")

/** @type {ReadonlyArray<readonly [name: string, version: string]>} */
const CONTRACTS = [
  ["device-meshcall", "1.0"],
  ["dsh-bridge", "3.0"],
  ["e2ee", "1.0"],
  ["preview", "1.0"],
  ["protocol", "1.2"],
]

/** @type {string[]} */
const problems = []

for (const [name, version] of CONTRACTS) {
  const contractDir = path.join(repositoryRoot, "contracts", name, version)
  const generatedDir = path.join(packageRoot, "src", "generated", name, `v${version.replace(".", "_")}`)
  const manifest = JSON.parse(await readFile(path.join(contractDir, "manifest.json"), "utf8"))
  const expected = new Map()

  for (const artifact of manifest.artifacts) {
    const schemaPath = path.join(contractDir, artifact.path)
    const bytes = await readFile(schemaPath)
    if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) {
      throw new Error(`${name}/${version}/${artifact.path} does not match its manifest checksum`)
    }
    const output = await compileFromFile(schemaPath, {
      bannerComment: [
        "/* eslint-disable */",
        `/** Generated from contracts/${name}/${version} artifact ${artifact.slug}. Do not edit; run \`yarn contracts:generate\`. */`,
      ].join("\n"),
      cwd: contractDir,
      enableConstEnums: false,
      style: { bracketSpacing: true, printWidth: 120, semi: false, singleQuote: false, trailingComma: "all" },
      unknownAny: true,
    })
    expected.set(`${artifact.slug}.ts`, output)
  }

  const index = [...expected.keys()]
    .sort()
    .map((file) => `export * as ${toIdentifier(file.replace(/\.ts$/, ""))} from "./${file.replace(/\.ts$/, ".js")}"`)
    .join("\n")
  expected.set("index.ts", `/* Generated. Do not edit. */\n${index}\n`)

  await mkdir(generatedDir, { recursive: true })
  const current = (await readdir(generatedDir)).filter((file) => file.endsWith(".ts"))

  if (checkOnly) {
    for (const [file, output] of expected) {
      const existing = await readFile(path.join(generatedDir, file), "utf8").catch(() => null)
      if (existing === null) problems.push(`${name}/${version}: ${file} is missing`)
      else if (existing !== output) problems.push(`${name}/${version}: ${file} is stale`)
    }
    for (const file of current) {
      if (!expected.has(file)) problems.push(`${name}/${version}: ${file} is not in the manifest`)
    }
  } else {
    for (const [file, output] of expected) await writeFile(path.join(generatedDir, file), output)
    for (const file of current) if (!expected.has(file)) await unlink(path.join(generatedDir, file))
  }
}

if (problems.length > 0) {
  console.error(problems.join("\n"))
  process.exitCode = 1
}

/** @param {string} slug */
function toIdentifier(slug) {
  return slug.replace(/-([a-z0-9])/g, (/** @type {string} */ _, /** @type {string} */ c) => c.toUpperCase())
}
