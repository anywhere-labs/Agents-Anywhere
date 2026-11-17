// A session the device has not opened yet reports the permission its native thread uses as
// `state.selections.permission` (v3: the Runtime's native session summary, connector-ts #764/#765). The session
// composer shows it through the permission catalog, and falls back to 「Runtime 默认」 when the catalog has no
// item for it. These tests run the composer's own code for that path, taken from its source.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import vm from "node:vm"
import ts from "typescript"

import {
  catalogI18nText,
  catalogItemDisabledReason,
  catalogItemEnabled,
  isDshAutoReviewPermission,
  permissionCatalogI18nText,
  permissionIdForSelectionId,
} from "../src/components/session/catalog-selection.ts"

const source = readFileSync(new URL("../src/components/session/session-composer.tsx", import.meta.url), "utf8")

function sourceBetween(start, end) {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`)
  assert.notEqual(endIndex, -1, `missing end marker: ${end}`)
  return source.slice(startIndex, endIndex)
}

// The composer's permission path: catalog items, the selection the runtime state reports, the effect that picks
// the selected item, and the label.
const items = sourceBetween("const permissionItems = permissionCatalog?.permissions.map(", "const modelItems =")
const value = sourceBetween("const permissionSelectionValue = permissionIdForSelectionId(", "const modelValue =")
const effect = sourceBetween("if (dsh) { setSelectedPermissionMode(permissionValue); return }", "}, [creatingSession, dsh, permissionItems")
const label = sourceBetween("const permissionLabel =", "const modelLabel =")
const program = ts.transpileModule(`
  function resolve() {
    const runtimeSelections = runtimeState?.selections ?? {}
    const runtimePermissionKnown = Object.prototype.hasOwnProperty.call(runtimeSelections, "permission")
    let selectedPermissionMode = ""
    const setSelectedPermissionMode = next => { selectedPermissionMode = next }
    ${items}
    ${value}
    ;(() => { ${effect} })()
    ${label}
    return { selected: selectedPermissionMode, label: permissionLabel }
  }
  resolve()
`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

const TRANSLATIONS = {
  "permissionModes.codex.fullAccess.label": "完全访问",
  runtimeDefault: "Runtime 默认",
  permissionUnsynced: "权限未同步",
}

function composerPermission({ catalog, runtimeState }) {
  return vm.runInNewContext(program, {
    permissionCatalog: catalog,
    runtimeState,
    creatingSession: false,
    dsh: false,
    actualPermission: undefined,
    tNew: key => TRANSLATIONS[key] ?? key,
    catalogI18nText,
    catalogItemDisabledReason,
    catalogItemEnabled,
    isDshAutoReviewPermission,
    permissionCatalogI18nText,
    permissionIdForSelectionId,
  })
}

const CODEX_CATALOG = {
  runtime: "codex",
  revision: 1,
  permissions: [
    { id: "read_only", displayName: "Read only", selectionId: "codex:permission:read_only", default: true, metadata: {} },
    {
      id: "full_access",
      displayName: "Full access",
      selectionId: "codex:permission:full_access",
      metadata: { i18n: { labelKey: "dashboard.new.permissionModes.codex.fullAccess.label" } },
    },
  ],
}

/** The snapshot / `GET runtime/state` of a session the device has not opened: only the native permission. */
const unopened = permission => ({ status: "idle", selections: { permission }, metadata: {} })

test("an unopened session shows its native permission through the permission catalog", () => {
  const shown = composerPermission({ catalog: CODEX_CATALOG, runtimeState: unopened("codex:permission:full_access") })
  assert.deepEqual({ ...shown }, { selected: "full_access", label: "完全访问" })
})

test("a native permission the catalog does not list shows the Runtime default", () => {
  const shown = composerPermission({ catalog: CODEX_CATALOG, runtimeState: unopened("codex:permission:unknown") })
  // Neither the reported id nor the catalog's default item is selected: the Runtime decides.
  assert.deepEqual({ ...shown }, { selected: "", label: "Runtime 默认" })
})

test("without a reported permission the composer still says it is not synced", () => {
  const shown = composerPermission({ catalog: CODEX_CATALOG, runtimeState: { status: "idle", selections: {}, metadata: {} } })
  assert.deepEqual({ ...shown }, { selected: "", label: "权限未同步" })
})
