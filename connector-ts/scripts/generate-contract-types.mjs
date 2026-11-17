// Generate TypeScript types for the v3 contracts consumed by the Connector.
//
// Source of truth: Pydantic models in server/agent_server/core, exported to
// contracts/<name>/<version>/ by server/scripts/export_v3_contracts.py (and
// export_workflow_schemas.py, export_protocol_schemas.py). This script verifies
// each schema against its manifest checksum and compiles it into
// src/generated/<name>/v<major>_<minor>/<slug>.ts. device-meshcall's extras
// also become constants and type maps: the E2EE registration, the business
// payload of every method (payloads.ts), the client route table
// (client-routes.ts) and the errors of a forwarded route (client-errors.ts).
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
  // Runtime Control 3.0 keeps the 2.1 schemas (contracts/runtime-control/3.0/README.md).
  ["runtime-control", "2.1"],
  ["runtime-workflows", "1.2"],
]

/** @typedef {{ contract: string, version: string, slug: string, model: string }} ArtifactRef */
/** @typedef {{ request: ArtifactRef, response: ArtifactRef, route: string, shape?: string }} MethodRef */

/** @type {string[]} */
const problems = []

/** Compiled output by contract key (`name/version`), then by file name. */
/** @type {Map<string, Map<string, string>>} */
const outputs = new Map()
/** Non-schema artifacts by contract key, then by path, already checksum-verified. */
/** @type {Map<string, Map<string, Buffer>>} */
const extras = new Map()

for (const [name, version] of CONTRACTS) {
  const contractDir = path.join(repositoryRoot, "contracts", name, version)
  const manifest = JSON.parse(await readFile(path.join(contractDir, "manifest.json"), "utf8"))
  /** @type {Map<string, string>} */
  const expected = new Map()
  /** @type {Map<string, Buffer>} */
  const extraFiles = new Map()

  for (const artifact of manifest.artifacts) {
    const schemaPath = path.join(contractDir, artifact.path)
    const bytes = await readFile(schemaPath)
    if (sha256(bytes) !== artifact.sha256) {
      throw new Error(`${name}/${version}/${artifact.path} does not match its manifest checksum`)
    }
    const output = await compileFromFile(schemaPath, {
      bannerComment: [
        "/* eslint-disable */",
        `/** Generated from contracts/${name}/${version} artifact ${artifact.slug}. Do not edit; run \`yarn contracts:generate\`. */`,
      ].join("\n"),
      // External `$ref`s (runtime-control) are relative to the schema file.
      cwd: path.dirname(schemaPath),
      enableConstEnums: false,
      style: { bracketSpacing: true, printWidth: 120, semi: false, singleQuote: false, trailingComma: "all" },
      unknownAny: true,
    })
    expected.set(`${artifact.slug}.ts`, output)
  }

  // Non-schema artifacts (device.meshcall.json, mesh-errors.json, e2ee-registration.json, ...): verify their
  // checksums too; some become constants below.
  for (const extra of manifest.extras ?? []) {
    const bytes = await readFile(path.join(contractDir, extra.path))
    if (sha256(bytes) !== extra.sha256) {
      throw new Error(`${name}/${version}/${extra.path} does not match its manifest checksum`)
    }
    extraFiles.set(extra.path, bytes)
  }
  outputs.set(`${name}/${version}`, expected)
  extras.set(`${name}/${version}`, extraFiles)
}

for (const [name, version] of CONTRACTS) {
  const key = `${name}/${version}`
  const expected = /** @type {Map<string, string>} */ (outputs.get(key))
  for (const [file, bytes] of /** @type {Map<string, Buffer>} */ (extras.get(key))) {
    const generated = generateExtra(name, version, file, JSON.parse(bytes.toString("utf8")))
    if (generated !== null) expected.set(generated[0], generated[1])
  }

  const index = [...expected.keys()]
    .sort()
    .map((file) => `export * as ${toIdentifier(file.replace(/\.ts$/, ""))} from "./${file.replace(/\.ts$/, ".js")}"`)
    .join("\n")
  expected.set("index.ts", `/* Generated. Do not edit. */\n${index}\n`)

  const generatedDir = path.join(packageRoot, "src", "generated", name, versionDir(version))
  await mkdir(generatedDir, { recursive: true })
  const current = (await readdir(generatedDir)).filter((file) => file.endsWith(".ts"))

  if (checkOnly) {
    for (const [file, output] of expected) {
      const existing = await readFile(path.join(generatedDir, file), "utf8").catch(() => null)
      if (existing === null) problems.push(`${key}: ${file} is missing`)
      else if (existing !== output) problems.push(`${key}: ${file} is stale`)
    }
    for (const file of current) {
      if (!expected.has(file)) problems.push(`${key}: ${file} is not in the manifest`)
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

/**
 * The TypeScript a non-schema artifact becomes, as `[file, source]`, or null when it stays JSON only.
 * @param {string} name
 * @param {string} version
 * @param {string} file
 * @param {any} table
 * @returns {[string, string] | null}
 */
function generateExtra(name, version, file, table) {
  const banner = [
    "/* eslint-disable */",
    `/** Generated from contracts/${name}/${version}/${file}. Do not edit; run \`yarn contracts:generate\`. */`,
    "",
  ]
  if (file === "e2ee-registration.json") {
    return [
      "e2ee-registration.ts",
      [
        ...banner,
        "/** Services and methods the device registers on the Router, per E2EE mode. */",
        `export const REGISTERED_SERVICES = ${JSON.stringify(table.modes, null, 2)} as const`,
        "",
        "/** Link/attach event methods allowed in plaintext, per E2EE mode. */",
        `export const ATTACH_EVENTS = ${JSON.stringify(table.attachEvents, null, 2)} as const`,
        "",
      ].join("\n"),
    ]
  }
  if (file === "payloads.json") return ["payloads.ts", [...banner, ...payloadTypes(name, version, table)].join("\n")]
  if (file === "client-routes.json") {
    return [
      "client-routes.ts",
      [
        ...banner,
        "/** The client API routes a device serves, alone or with the Server (`core/client_routes.py`). */",
        `export const CLIENT_ROUTES = ${JSON.stringify(table.routes, null, 2)} as const`,
        "",
        "export type ClientRouteEntry = (typeof CLIENT_ROUTES)[number]",
        "",
        "/** Path prefixes E2EE `required` mode refuses as a whole; `plain` routes under them are the exceptions. */",
        `export const ROUTE_FAMILIES = ${JSON.stringify(table.families, null, 2)} as const`,
        "",
        "/** Body fields a command route may take its command id from. */",
        `export const COMMAND_ID_FIELDS = ${JSON.stringify(table.commandIdFields)} as const`,
        "",
        "/** `commandId` of a route: generated, carried only in `ClientCallRequest.command`. */",
        `export const GENERATED_COMMAND_ID = ${JSON.stringify(table.generatedCommandId)}`,
        "",
        "/** Seconds per route timeout; `read` is the Server's read timeout setting. */",
        `export const TIMEOUT_SECONDS = ${JSON.stringify(table.timeoutSeconds, null, 2)} as const`,
        "",
        `export const CLIENT_LIMITS = ${JSON.stringify(table.limits, null, 2)} as const`,
        "",
      ].join("\n"),
    ]
  }
  if (file === "client-errors.json") {
    return [
      "client-errors.ts",
      [
        ...banner,
        "/** What the Server answers a client, per failure of a forwarded route, for reads and commands. */",
        `export const CLIENT_ERROR_RULES = ${JSON.stringify(table.rules, null, 2)} as const`,
        "",
        "/** MeshCall error codes of `Client/call` with a case of their own. */",
        `export const CLIENT_MESH_CASES = ${JSON.stringify(table.meshCases, null, 2)} as const`,
        "",
        "/** AA error code a device raises -> HTTP status; any other code is `DEVICE_CODE_DEFAULT_STATUS`. */",
        `export const DEVICE_CODE_STATUS: Readonly<Record<string, number>> = ${JSON.stringify(table.deviceCodeStatus, null, 2)}`,
        "",
        `export const DEVICE_CODE_DEFAULT_STATUS = ${JSON.stringify(table.deviceCodeDefaultStatus)}`,
        "",
      ].join("\n"),
    ]
  }
  return null
}

/**
 * `payloads.json` as type maps: business method -> its request and response types.
 * @param {string} name
 * @param {string} version
 * @param {{ commands: Record<string, MethodRef>, reads: Record<string, MethodRef>, events: Record<string, ArtifactRef>, outbox: Record<string, ArtifactRef> }} table
 * @returns {string[]}
 */
function payloadTypes(name, version, table) {
  /** @type {Map<string, { from: string, ref: ArtifactRef }>} */
  const imports = new Map()
  /** @param {ArtifactRef} ref */
  const use = (ref) => {
    const typeName = exportedType(ref)
    const from = ref.contract === name && ref.version === version
      ? `./${ref.slug}.js`
      : `../../${ref.contract}/${versionDir(ref.version)}/${ref.slug}.js`
    const known = imports.get(typeName)
    if (known !== undefined && known.from !== from) throw new Error(`${typeName} is exported by two contracts`)
    imports.set(typeName, { from, ref })
    return typeName
  }
  /** @param {Record<string, MethodRef>} methods */
  const pairs = (methods) =>
    Object.entries(methods).map(([method, ref]) => `  ${JSON.stringify(method)}: { request: ${use(ref.request)}; response: ${use(ref.response)} }`)
  /** @param {Record<string, ArtifactRef>} methods */
  const singles = (methods) => Object.entries(methods).map(([method, ref]) => `  ${JSON.stringify(method)}: ${use(ref)}`)
  /** @param {Record<string, MethodRef>} methods */
  const routes = (methods) => Object.fromEntries(Object.entries(methods).map(([method, ref]) => [method, ref.route]))

  const body = [
    "/** `CommandCall.p` (request) and `CommandAck.r` (response) of every `aa.device.v1.Commands/*` method. */",
    "export interface CommandPayloads {",
    ...pairs(table.commands),
    "}",
    "",
    "/** Request and response of every Server-initiated read; for a stream the response is its item. */",
    "export interface ReadPayloads {",
    ...pairs(table.reads),
    "}",
    "",
    "/** `LinkAttachItem.p` by `LinkAttachItem.m`. */",
    "export interface EventPayloads {",
    ...singles(table.events),
    "}",
    "",
    "/** `OutboxItem.p` by `OutboxItem.m`. */",
    "export interface OutboxPayloads {",
    ...singles(table.outbox),
    "}",
    "",
    "export type CommandMethod = keyof CommandPayloads",
    "export type ReadMethod = keyof ReadPayloads",
    "export type EventMethod = keyof EventPayloads",
    "export type OutboxMethod = keyof OutboxPayloads",
    "",
    "/** Business method -> MeshCall `service/method`. */",
    `export const COMMAND_ROUTES = ${JSON.stringify(routes(table.commands), null, 2)} as const`,
    "",
    `export const READ_ROUTES = ${JSON.stringify(routes(table.reads), null, 2)} as const`,
    "",
  ]
  const head = [...imports]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([typeName, { from }]) => `import type { ${typeName} } from "${from}"`)
  return [...head, "", ...body]
}

/**
 * The type an artifact's generated file exports for its root model (its schema title).
 * @param {ArtifactRef} ref
 */
function exportedType(ref) {
  const source = outputs.get(`${ref.contract}/${ref.version}`)?.get(`${ref.slug}.ts`)
  if (source === undefined) throw new Error(`payloads.json names ${ref.contract}/${ref.version} ${ref.slug}, which is not generated`)
  if (!new RegExp(`^export (interface|type) ${ref.model}\\b`, "m").test(source)) {
    throw new Error(`${ref.contract}/${ref.version}/${ref.slug}.ts does not export ${ref.model}`)
  }
  return ref.model
}

/** @param {Buffer} bytes */
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

/** @param {string} version */
function versionDir(version) {
  return `v${version.replace(".", "_")}`
}

/** @param {string} slug */
function toIdentifier(slug) {
  return slug.replace(/-([a-z0-9])/g, (/** @type {string} */ _, /** @type {string} */ c) => c.toUpperCase())
}
