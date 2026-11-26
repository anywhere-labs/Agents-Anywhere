// Signing in to an agent that wants it before it opens sessions: what the device said about it (details of
// `agent_auth_required`), and the call that waits until someone has signed in.
import { DeadlineExceededError, MeshCallError } from "meshcall/web"

import type { SignInMethod } from "@/lib/types/v3"

export interface SignInNeeded {
  /** What the agent said, in its own words ("" from a Connector that does not pass it on). */
  message: string
  methods: SignInMethod[]
}

/** What an `agent_auth_required` error says about signing in; null for any other error. */
export function signInNeeded(error: unknown): SignInNeeded | null {
  if (!(error instanceof MeshCallError) || error.reason !== "agent_auth_required") return null
  const { agent_message: message, auth_methods: methods } = error.details ?? {}
  return {
    message: typeof message === "string" ? message : "",
    // Without a kind it is from a Connector that cannot sign in yet.
    methods: Array.isArray(methods)
      ? methods.filter(
          (m): m is SignInMethod =>
            typeof m === "object" && m !== null && typeof m.id === "string" && typeof m.name === "string" && (m.kind === "agent" || m.kind === "terminal")
        )
      : [],
  }
}

/** Repeat a call that joins what is running on the device until it answers. */
export async function untilAnswered<T>(call: () => Promise<T>): Promise<T> {
  for (;;) {
    try {
      return await call()
    } catch (error) {
      if (!(error instanceof DeadlineExceededError)) throw error
    }
  }
}

/** Why the agent did not start; with no way to sign in from here, what it says itself. */
export function signInText(t: (key: "agentSignIn.needed" | "agentSignIn.neededSays", values: Record<string, string>) => string, agent: string, needed: SignInNeeded | null): string {
  return needed && needed.methods.length === 0 && needed.message
    ? t("agentSignIn.neededSays", { agent, message: needed.message })
    : t("agentSignIn.needed", { agent })
}
