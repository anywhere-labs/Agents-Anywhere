import { describe, expect, it } from "vitest"

import { argumentsText } from "@/components/conversation/text"
import type { ToolPart } from "@/lib/types/v3"

const call = (input: unknown): ToolPart => ({ type: "tool", id: "call_1", title: "deploy", kind: "other", status: "pending", input })

describe("a call's arguments, on its approval card", () => {
  it("are one per line; text as it is, anything else as JSON, nothing left out but what is not there", () => {
    expect(argumentsText(call({ env: "prod", replicas: 2, dry_run: false, note: "", region: null, tags: ["a", "b"] }))).toBe(
      'env: prod\nreplicas: 2\ndry_run: false\nnote: ""\ntags: ["a","b"]'
    )
    const long = { to: "someone@example.com", subject: "A subject long enough", body: "and a body that makes it longer" }
    expect(argumentsText(call({ mail: long }))).toBe(`mail:\n${JSON.stringify(long, null, 2)}`)
    expect(argumentsText(call({ path: "notes.md", content: "one\ntwo" }))).toBe("path: notes.md\ncontent:\none\ntwo")
    expect(argumentsText(call("just text"))).toBe("just text")
    expect(argumentsText(call(undefined))).toBe("")
    expect(argumentsText(call({}))).toBe("")
  })

  it("leave out only what the title already ends with", () => {
    expect(argumentsText(call({ path: "notes.md", content: "x" }), "Write notes.md")).toBe("content: x")
    expect(argumentsText(call({ path: "/etc/hosts" }), "Read /etc/hosts")).toBe("")
    // Part of a word, or said earlier in the title, is not the same argument.
    expect(argumentsText(call({ env: "prod", count: 1 }), "deploy to nonprod")).toBe("env: prod\ncount: 1")
    expect(argumentsText(call({ env: "prod" }), "prod deploy")).toBe("env: prod")
    expect(argumentsText(call({ content: "" }), "Write notes.md")).toBe('content: ""')
  })
})
