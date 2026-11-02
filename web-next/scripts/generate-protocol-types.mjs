import { readFile, readdir, mkdir, unlink, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import path from "node:path"

import { compileFromFile } from "json-schema-to-typescript"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const webRoot = path.resolve(scriptDir, "..")
const repositoryRoot = path.resolve(webRoot, "..")
const checkOnly = process.argv.includes("--check")
const contracts = [
  { contractDir: path.join(repositoryRoot, "contracts", "protocol", "1.1"),
    generatedDir: path.join(webRoot, "src", "generated", "protocol", "v1_1") },
  { contractDir: path.join(repositoryRoot, "contracts", "runtime-workflows", "1.2"),
    generatedDir: path.join(webRoot, "src", "generated", "runtime-workflows", "v1_2") },
]

for (const { contractDir, generatedDir } of contracts) {
  const manifest = JSON.parse(await readFile(path.join(contractDir, "manifest.json"), "utf8"))
  const artifacts = manifest.artifacts.filter((artifact) => artifact.direction !== "ingress")
  const expected = new Map()

  for (const artifact of artifacts) {
    const schemaBytes = await readFile(path.join(contractDir, artifact.path))
    if (createHash("sha256").update(schemaBytes).digest("hex") !== artifact.sha256) {
      throw new Error(`${contractDir}/${artifact.path} does not match the manifest checksum`)
    }
    const output = await compileFromFile(path.join(contractDir, artifact.path), {
      bannerComment: [
        "/* eslint-disable */",
        "/**",
        ` * Generated from protocol ${manifest.protocolVersion} artifact ${artifact.slug}.`,
        " * Do not edit by hand; run `yarn protocol:generate`.",
        " */",
      ].join("\n"),
      cwd: contractDir,
      enableConstEnums: false,
      style: {
        bracketSpacing: true,
        printWidth: 120,
        semi: false,
        singleQuote: false,
        trailingComma: "all",
      },
      unknownAny: true,
    })
    expected.set(`${artifact.slug}.ts`, output)
  }

  await mkdir(generatedDir, { recursive: true })
  const currentFiles = (await readdir(generatedDir)).filter((file) => file.endsWith(".ts"))

  if (checkOnly) {
    const problems = []
    for (const [file, output] of expected) {
      try {
        const current = await readFile(path.join(generatedDir, file), "utf8")
        if (current !== output) problems.push(`${file} is stale`)
      } catch {
        problems.push(`${file} is missing`)
      }
    }
    for (const file of currentFiles) {
      if (!expected.has(file)) problems.push(`${file} is not in the protocol manifest`)
    }
    if (problems.length > 0) {
      console.error(problems.join("\n"))
      process.exitCode = 1
    }
  } else {
    for (const [file, output] of expected) {
      await writeFile(path.join(generatedDir, file), output)
    }
    for (const file of currentFiles) {
      if (!expected.has(file)) await unlink(path.join(generatedDir, file))
    }
  }
}
