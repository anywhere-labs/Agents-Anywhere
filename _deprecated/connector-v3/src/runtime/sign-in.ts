/**
 * The ways an agent can be signed in to: its own (ACP `authMethods`), and the sign-in command of its program when the
 * catalog knows one and the agent itself offers nothing to run in a terminal.
 */

import type { AcpAuthMethod } from "../core/acp-protocol.js";

/** A way to sign in, as clients see it. */
export interface SignInMethod {
  id: string;
  name: string;
  description?: string;
  /** `agent`: the agent does it when asked to (`sign_in_agent`); `terminal`: in a terminal (`sign_in_terminal`). */
  kind: "agent" | "terminal";
}

/** A program run in a terminal to sign in. */
export interface SignInCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** The method id of its program's own sign-in command. */
export const PROGRAM_SIGN_IN = "aa:program";

export function isTerminalMethod(method: AcpAuthMethod): boolean {
  return method.type === "terminal" || terminalCommand(method) !== undefined;
}

/** The whole command of a terminal sign-in, where the agent still names it as clients asked for it earlier (Copilot). */
export function terminalCommand(method: AcpAuthMethod): SignInCommand | undefined {
  const named = method._meta?.["terminal-auth"] as Partial<SignInCommand> | null | undefined;
  if (typeof named !== "object" || named === null || typeof named.command !== "string" || named.command === "") return undefined;
  const { command, args, env } = named;
  return {
    command,
    args: Array.isArray(args) ? args.filter((arg) => typeof arg === "string") : [],
    env: typeof env === "object" && env !== null ? Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === "string")) : {},
  };
}

/** One that takes a key along (`authenticate` with `_meta["api-key"]`): keys are set as environment variables here. */
function wantsKey(method: AcpAuthMethod): boolean {
  return method._meta?.["api-key"] != null;
}

/** What the agent offers, unusable entries left out. */
export function offeredMethods(methods: unknown): AcpAuthMethod[] {
  if (!Array.isArray(methods)) return [];
  return (methods as Partial<AcpAuthMethod>[]).filter(
    (method): method is AcpAuthMethod =>
      typeof method?.id === "string" &&
      method.id !== "" &&
      typeof method.name === "string" &&
      (method.type === undefined || method.type === null || method.type === "agent" || method.type === "terminal") &&
      !wantsKey(method as AcpAuthMethod),
  );
}

export function signInMethods(offered: readonly AcpAuthMethod[], program: { command: string; args: readonly string[] } | undefined): SignInMethod[] {
  const methods: SignInMethod[] = offered.map((method) => ({
    id: method.id,
    name: method.name,
    ...(method.description ? { description: method.description } : {}),
    kind: isTerminalMethod(method) ? "terminal" : "agent",
  }));
  if (program !== undefined && !methods.some(({ kind }) => kind === "terminal")) {
    const name = program.command.split(/[\\/]/u).pop()?.replace(/\.(?:exe|cmd|bat)$/iu, "") ?? program.command;
    methods.push({ id: PROGRAM_SIGN_IN, name: [name, ...program.args].join(" "), kind: "terminal" });
  }
  return methods;
}
