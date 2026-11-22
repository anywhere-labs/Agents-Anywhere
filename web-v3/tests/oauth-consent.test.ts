import { describe, expect, it } from "vitest"

import {
  buildDenyRedirect,
  buildSignInHref,
  canApprove,
  defaultSelectedScopes,
  parseAuthorizeQuery,
  redirectHostLabel,
  safeNextPath,
  visibleScopes,
} from "@/lib/oauth/consent"
import type { McpConsentScopeView } from "@/lib/types/v3"

const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"

function query(overrides: Record<string, string | null> = {}): URLSearchParams {
  const base: Record<string, string | null> = {
    response_type: "code",
    client_id: "aamcpcl_123",
    redirect_uri: "http://127.0.0.1:4321/callback",
    scope: "devices:read sessions:read devices:read",
    state: "s t&a=te",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    resource: "https://aa.example.test/mcp",
    ...overrides,
  }
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(base)) if (v !== null) params.set(k, v)
  return params
}

const PREVIEW_SCOPES: McpConsentScopeView[] = [
  { scope: "devices:read", default_checked: true, high_risk: false },
  { scope: "sessions:read", default_checked: true, high_risk: false },
  { scope: "sessions:write", default_checked: false, high_risk: false },
  { scope: "approvals:answer", default_checked: false, high_risk: true },
]

describe("parseAuthorizeQuery", () => {
  it("parses a full MCP authorization request", () => {
    expect(parseAuthorizeQuery(query())).toEqual({
      ok: true,
      request: {
        clientId: "aamcpcl_123",
        redirectUri: "http://127.0.0.1:4321/callback",
        scopes: ["devices:read", "sessions:read"],
        state: "s t&a=te",
        codeChallenge: CHALLENGE,
        codeChallengeMethod: "S256",
      },
    })
  })

  it("defaults the PKCE method to S256 and tolerates a missing scope, state and response_type", () => {
    const parsed = parseAuthorizeQuery(
      query({ code_challenge_method: null, scope: null, state: null, response_type: null })
    )
    expect(parsed.ok && parsed.request).toMatchObject({ scopes: [], state: null, codeChallengeMethod: "S256" })
  })

  it.each([
    [{ client_id: null }, "missing_client_id"],
    [{ client_id: "  " }, "missing_client_id"],
    [{ redirect_uri: null }, "missing_redirect_uri"],
    [{ response_type: "token" }, "unsupported_response_type"],
    [{ code_challenge: null }, "missing_code_challenge"],
    [{ code_challenge_method: "plain" }, "unsupported_code_challenge_method"],
  ] as const)("rejects %j with %s", (overrides, error) => {
    expect(parseAuthorizeQuery(query(overrides))).toEqual({ ok: false, error })
  })
})

describe("sign-in round trip", () => {
  it("returns to the exact consent URL after signing in", () => {
    const returnTo = `/oauth/authorize?${query().toString()}`
    const href = buildSignInHref(returnTo)
    const url = new URL(href, "https://app.example.test")
    expect(url.pathname).toBe("/sign-in")
    expect(url.searchParams.get("add")).toBeNull()
    expect(safeNextPath(url.searchParams.get("next"))).toBe(returnTo)

    const add = new URL(buildSignInHref(returnTo, { addAccount: true }), "https://app.example.test")
    expect(add.searchParams.get("add")).toBe("1")
  })

  it("only accepts same-origin paths as the next destination", () => {
    expect(safeNextPath("/oauth/authorize?client_id=x")).toBe("/oauth/authorize?client_id=x")
    expect(safeNextPath(null)).toBeNull()
    expect(safeNextPath("")).toBeNull()
    expect(safeNextPath("https://evil.example/")).toBeNull()
    expect(safeNextPath("//evil.example/")).toBeNull()
    expect(safeNextPath("/\\evil.example/")).toBeNull()
    expect(safeNextPath("javascript:alert(1)")).toBeNull()
  })
})

describe("deny redirect", () => {
  it("appends access_denied and the original state", () => {
    const url = new URL(buildDenyRedirect("http://127.0.0.1:4321/callback?x=1", "s t&a=te"))
    expect(url.origin + url.pathname).toBe("http://127.0.0.1:4321/callback")
    expect(Object.fromEntries(url.searchParams)).toEqual({
      x: "1",
      error: "access_denied",
      state: "s t&a=te",
    })
  })

  it("omits state when the client sent none and supports custom schemes", () => {
    expect(buildDenyRedirect("cursor://anysphere.cursor-mcp/oauth/callback", null)).toBe(
      "cursor://anysphere.cursor-mcp/oauth/callback?error=access_denied"
    )
  })
})

describe("consent selections", () => {
  it("labels where the code goes", () => {
    expect(redirectHostLabel("http://127.0.0.1:4321/callback")).toBe("127.0.0.1:4321")
    expect(redirectHostLabel("https://claude.ai/api/mcp/auth_callback")).toBe("claude.ai")
    expect(redirectHostLabel("cursor://anysphere.cursor-mcp/oauth/callback")).toBe(
      "cursor://anysphere.cursor-mcp"
    )
  })

  it("offers only requested scopes, or all of them when none are known", () => {
    expect(visibleScopes(PREVIEW_SCOPES, ["devices:read"]).map((s) => s.scope)).toEqual(["devices:read"])
    expect(visibleScopes(PREVIEW_SCOPES, ["mcp"]).map((s) => s.scope)).toHaveLength(4)
    expect(visibleScopes(PREVIEW_SCOPES, []).map((s) => s.scope)).toHaveLength(4)
  })

  it("never pre-checks the high-risk approvals scope", () => {
    const forced = PREVIEW_SCOPES.map((s) => ({ ...s, default_checked: true }))
    expect(defaultSelectedScopes(forced)).not.toContain("approvals:answer")
    expect(defaultSelectedScopes(PREVIEW_SCOPES)).toEqual(["devices:read", "sessions:read"])
  })

  it("requires at least one scope and one device", () => {
    expect(canApprove({ scopes: ["devices:read"], deviceIds: ["d1"] })).toBe(true)
    expect(canApprove({ scopes: [], deviceIds: ["d1"] })).toBe(false)
    expect(canApprove({ scopes: ["devices:read"], deviceIds: [] })).toBe(false)
  })
})
