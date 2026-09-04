"use client"

import { Icon } from "@iconify/react/offline"
import defaultFile from "@iconify-icons/vscode-icons/default-file"
import fileTypeAstro from "@iconify-icons/vscode-icons/file-type-astro"
import fileTypeAudio from "@iconify-icons/vscode-icons/file-type-audio"
import fileTypeBinary from "@iconify-icons/vscode-icons/file-type-binary"
import fileTypeC from "@iconify-icons/vscode-icons/file-type-c"
import fileTypeCpp from "@iconify-icons/vscode-icons/file-type-cpp"
import fileTypeCsharp from "@iconify-icons/vscode-icons/file-type-csharp"
import fileTypeCss from "@iconify-icons/vscode-icons/file-type-css"
import fileTypeDb from "@iconify-icons/vscode-icons/file-type-db"
import fileTypeDiff from "@iconify-icons/vscode-icons/file-type-diff"
import fileTypeDocker from "@iconify-icons/vscode-icons/file-type-docker"
import fileTypeDotenv from "@iconify-icons/vscode-icons/file-type-dotenv"
import fileTypeExcel from "@iconify-icons/vscode-icons/file-type-excel"
import fileTypeGit from "@iconify-icons/vscode-icons/file-type-git"
import fileTypeGo from "@iconify-icons/vscode-icons/file-type-go"
import fileTypeGraphql from "@iconify-icons/vscode-icons/file-type-graphql"
import fileTypeHtml from "@iconify-icons/vscode-icons/file-type-html"
import fileTypeImage from "@iconify-icons/vscode-icons/file-type-image"
import fileTypeIni from "@iconify-icons/vscode-icons/file-type-ini"
import fileTypeJava from "@iconify-icons/vscode-icons/file-type-java"
import fileTypeJs from "@iconify-icons/vscode-icons/file-type-js"
import fileTypeJson from "@iconify-icons/vscode-icons/file-type-json"
import fileTypeKotlin from "@iconify-icons/vscode-icons/file-type-kotlin"
import fileTypeLess from "@iconify-icons/vscode-icons/file-type-less"
import fileTypeMakefile from "@iconify-icons/vscode-icons/file-type-makefile"
import fileTypeMarkdown from "@iconify-icons/vscode-icons/file-type-markdown"
import fileTypePdf from "@iconify-icons/vscode-icons/file-type-pdf2"
import fileTypePhp from "@iconify-icons/vscode-icons/file-type-php"
import fileTypePowerpoint from "@iconify-icons/vscode-icons/file-type-powerpoint"
import fileTypePython from "@iconify-icons/vscode-icons/file-type-python"
import fileTypeReact from "@iconify-icons/vscode-icons/file-type-reactjs"
import fileTypeReactTs from "@iconify-icons/vscode-icons/file-type-reactts"
import fileTypeRuby from "@iconify-icons/vscode-icons/file-type-ruby"
import fileTypeRust from "@iconify-icons/vscode-icons/file-type-rust"
import fileTypeScss from "@iconify-icons/vscode-icons/file-type-scss"
import fileTypeShell from "@iconify-icons/vscode-icons/file-type-shell"
import fileTypeSql from "@iconify-icons/vscode-icons/file-type-sql"
import fileTypeSvelte from "@iconify-icons/vscode-icons/file-type-svelte"
import fileTypeSvg from "@iconify-icons/vscode-icons/file-type-svg"
import fileTypeSwift from "@iconify-icons/vscode-icons/file-type-swift"
import fileTypeText from "@iconify-icons/vscode-icons/file-type-text"
import fileTypeToml from "@iconify-icons/vscode-icons/file-type-toml"
import fileTypeTsconfig from "@iconify-icons/vscode-icons/file-type-tsconfig"
import fileTypeTypescript from "@iconify-icons/vscode-icons/file-type-typescript"
import fileTypeTypescriptDef from "@iconify-icons/vscode-icons/file-type-typescriptdef"
import fileTypeVideo from "@iconify-icons/vscode-icons/file-type-video"
import fileTypeVue from "@iconify-icons/vscode-icons/file-type-vue"
import fileTypeWord from "@iconify-icons/vscode-icons/file-type-word"
import fileTypeXml from "@iconify-icons/vscode-icons/file-type-xml"
import fileTypeYaml from "@iconify-icons/vscode-icons/file-type-yaml"
import fileTypeYarn from "@iconify-icons/vscode-icons/file-type-yarn"
import fileTypeZip from "@iconify-icons/vscode-icons/file-type-zip"

import { cn } from "@/lib/utils"

type FileIconData = typeof defaultFile

const EXACT_FILE_ICONS: Record<string, FileIconData> = {
  ".dockerignore": fileTypeDocker,
  ".gitattributes": fileTypeGit,
  ".gitignore": fileTypeGit,
  ".gitmodules": fileTypeGit,
  ".yarnrc": fileTypeYarn,
  ".yarnrc.yml": fileTypeYarn,
  ".yarnrc.yaml": fileTypeYarn,
  "compose.yaml": fileTypeDocker,
  "compose.yml": fileTypeDocker,
  "docker-compose.yaml": fileTypeDocker,
  "docker-compose.yml": fileTypeDocker,
  "dockerfile": fileTypeDocker,
  "makefile": fileTypeMakefile,
  "tsconfig.json": fileTypeTsconfig,
  "yarn.lock": fileTypeYarn,
}

const EXTENSION_ICONS: Record<string, FileIconData> = {
  "7z": fileTypeZip,
  aac: fileTypeAudio,
  astro: fileTypeAstro,
  avi: fileTypeVideo,
  bash: fileTypeShell,
  bin: fileTypeBinary,
  bmp: fileTypeImage,
  bz2: fileTypeZip,
  c: fileTypeC,
  cc: fileTypeCpp,
  cjs: fileTypeJs,
  cpp: fileTypeCpp,
  cs: fileTypeCsharp,
  css: fileTypeCss,
  csv: fileTypeExcel,
  diff: fileTypeDiff,
  doc: fileTypeWord,
  docx: fileTypeWord,
  env: fileTypeDotenv,
  gif: fileTypeImage,
  go: fileTypeGo,
  gql: fileTypeGraphql,
  graphql: fileTypeGraphql,
  gz: fileTypeZip,
  h: fileTypeC,
  hpp: fileTypeCpp,
  htm: fileTypeHtml,
  html: fileTypeHtml,
  ini: fileTypeIni,
  java: fileTypeJava,
  jpeg: fileTypeImage,
  jpg: fileTypeImage,
  js: fileTypeJs,
  json: fileTypeJson,
  jsonc: fileTypeJson,
  jsx: fileTypeReact,
  kt: fileTypeKotlin,
  kts: fileTypeKotlin,
  less: fileTypeLess,
  log: fileTypeText,
  m4a: fileTypeAudio,
  md: fileTypeMarkdown,
  mdx: fileTypeMarkdown,
  mjs: fileTypeJs,
  mov: fileTypeVideo,
  mp3: fileTypeAudio,
  mp4: fileTypeVideo,
  ogg: fileTypeAudio,
  patch: fileTypeDiff,
  pdf: fileTypePdf,
  php: fileTypePhp,
  png: fileTypeImage,
  ppt: fileTypePowerpoint,
  pptx: fileTypePowerpoint,
  py: fileTypePython,
  rar: fileTypeZip,
  rb: fileTypeRuby,
  rs: fileTypeRust,
  scss: fileTypeScss,
  sh: fileTypeShell,
  sql: fileTypeSql,
  sqlite: fileTypeDb,
  sqlite3: fileTypeDb,
  svg: fileTypeSvg,
  svelte: fileTypeSvelte,
  swift: fileTypeSwift,
  tar: fileTypeZip,
  toml: fileTypeToml,
  ts: fileTypeTypescript,
  tsx: fileTypeReactTs,
  txt: fileTypeText,
  vue: fileTypeVue,
  wav: fileTypeAudio,
  webp: fileTypeImage,
  xls: fileTypeExcel,
  xlsx: fileTypeExcel,
  xml: fileTypeXml,
  yaml: fileTypeYaml,
  yml: fileTypeYaml,
  zip: fileTypeZip,
  zsh: fileTypeShell,
}

export function FileTypeIcon({ name, className }: { name: string; className?: string }) {
  return (
    <Icon
      aria-hidden="true"
      className={cn("aa-file-type-icon", className)}
      icon={iconForFile(name)}
    />
  )
}

function iconForFile(rawName: string): FileIconData {
  const name = rawName.trim().toLowerCase()
  const exact = EXACT_FILE_ICONS[name]
  if (exact) return exact

  if (name === "license" || name.startsWith("license.") || name === "notice" || name === "copying") {
    return defaultFile
  }
  if (name === ".env" || name.startsWith(".env.")) return fileTypeDotenv
  if (name === "package.json" || name.endsWith("-lock.json")) return fileTypeJson
  if (/^readme(?:\.[^.]+)?\.md$/.test(name) || name === "readme") return fileTypeMarkdown
  if (/^(?:js|ts)config(?:\.[^.]+)?\.json$/.test(name)) return fileTypeTsconfig
  if (name.endsWith(".d.ts")) return fileTypeTypescriptDef

  const dot = name.lastIndexOf(".")
  if (dot < 0 || dot === name.length - 1) return defaultFile
  return EXTENSION_ICONS[name.slice(dot + 1)] ?? defaultFile
}
