import assert from "node:assert/strict"
import test from "node:test"

import {
  DEFAULT_ADMIN_SECTION,
  adminNavigation,
  adminSections,
  isAdminDataSection,
  isAdminServiceSection,
  legacyAdminRoutes,
  parseAdminSection,
  servicePageKey,
} from "../src/features/admin/navigation.ts"

test("every administration section appears in exactly one sidebar group", () => {
  const listed = adminNavigation.flatMap((group) => [...group.sections])
  assert.deepEqual([...listed].sort(), [...adminSections].sort())
  assert.equal(new Set(listed).size, listed.length)
  assert.deepEqual(adminNavigation.map((group) => group.group), ["data", "management", "service"])
})

test("unknown or missing sections fall back to the overview", () => {
  assert.equal(DEFAULT_ADMIN_SECTION, "overview")
  assert.equal(parseAdminSection(undefined), "overview")
  assert.equal(parseAdminSection(""), "overview")
  assert.equal(parseAdminSection("records"), "overview")
  assert.equal(parseAdminSection("team"), "team")
})

test("legacy routes map onto sections and the data group mirrors the usage board tabs", () => {
  assert.deepEqual(legacyAdminRoutes, { dashboard: "overview", team: "team", service: "service-general" })
  for (const section of Object.values(legacyAdminRoutes)) assert.ok(adminSections.includes(section), section)
  assert.deepEqual(adminSections.filter(isAdminDataSection), ["overview", "users", "usage", "devices", "quality"])
  assert.equal(isAdminDataSection("announcements"), false)
  assert.deepEqual(adminSections.filter(isAdminServiceSection), ["service-general", "service-auth", "service-email", "service-info"])
  assert.equal(servicePageKey("service-auth"), "auth")
})
