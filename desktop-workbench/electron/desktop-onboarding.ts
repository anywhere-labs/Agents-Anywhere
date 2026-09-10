import { DESKTOP_OAUTH_PROTOCOL } from "./desktop-oauth";

/**
 * Deep-link entry into the Desktop onboarding flow.
 *
 * The DSH plugin opens
 * `agents-anywhere-desktop://onboarding?source=dsh-plugin&flowId=<id>`
 * every time the user asks to configure this machine from the plugin, so a
 * plugin entry always shows the flow regardless of the completion flag.
 *
 * A user launch never comes from a URL: the main process builds the same route
 * with `source=desktop` after checking the shared local machine record.
 */

export type DesktopOnboardingSource = "desktop" | "dsh-plugin";

export type DesktopOnboardingEntry = {
  source: DesktopOnboardingSource;
  flowId: string | null;
  /** Hash route the renderer opens, query included. */
  route: string;
  /** Stable identity so a redelivered URL is handled once. */
  key: string;
};

const FLOW_ID_PATTERN = /^[A-Za-z0-9_-]{16,100}$/;

export function desktopOnboardingRoute(input: {
  source: DesktopOnboardingSource;
  flowId?: string | null;
}): string {
  const params = new URLSearchParams({ source: input.source });
  if (input.flowId) params.set("flowId", input.flowId);
  return `/#/onboarding?${params.toString()}`;
}

/**
 * Only a `dsh-plugin` entry may arrive from outside. Anything malformed is
 * ignored instead of being turned into a half-configured flow, and no URL may
 * carry a command, an executable path, or a redirect target.
 */
export function desktopOnboardingFromUrl(rawUrl: string): DesktopOnboardingEntry | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${DESKTOP_OAUTH_PROTOCOL}:` || url.hostname !== "onboarding") return null;
  const flowId = url.searchParams.get("flowId") ?? "";
  if (flowId && !FLOW_ID_PATTERN.test(flowId)) return null;
  const entry = { source: "dsh-plugin" as const, flowId: flowId || null };
  return { ...entry, route: desktopOnboardingRoute(entry), key: `dsh-plugin:${flowId}` };
}

export function desktopOnboardingFromArgv(argv: readonly string[]): DesktopOnboardingEntry | null {
  for (const value of argv) {
    const entry = desktopOnboardingFromUrl(value);
    if (entry) return entry;
  }
  return null;
}
