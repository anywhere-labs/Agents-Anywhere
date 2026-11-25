/**
 * How much of their subscription the agents the user signed in to with one have used: Claude Code's (Claude Pro /
 * Max) and Codex's (ChatGPT plans) usage windows, read with the agent's own sign-in on this device. Ported from CC
 * Switch (https://github.com/farion1231/cc-switch, `src-tauri/src/services/subscription.rs`, MIT, © Jason Young):
 * where the credentials are, the endpoints and headers, and how the answers are read.
 *
 * Only reads: never signs in, refreshes a token or writes anything. Both endpoints are the ones the agents' own
 * status views use, not public APIs: an answer that cannot be read is reported, not guessed at.
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type UsageAgent = "claude" | "codex";

export function usageAgentOf(agentId: string): UsageAgent | undefined {
  return agentId === "claude" || agentId === "codex" ? agentId : undefined;
}

/** One limit: `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `seven_day_fable`, `30_day`, … */
export interface UsageWindow {
  name: string;
  /** 0–100. */
  usedPercent: number;
  /** ISO 8601. */
  resetsAt?: string;
}

export interface SubscriptionUsage {
  agent: UsageAgent;
  /**
   * `ok`: read. `signed_out`: not signed in with a subscription on this device (or with an API key). `expired`: the
   * sign-in has run out: sign in again. `refresh_pending`: the agent renews it itself the next time it runs.
   * `error`: it could not be read (`error` says why).
   */
  status: "ok" | "signed_out" | "expired" | "refresh_pending" | "error";
  plan?: string;
  windows: UsageWindow[];
  /** Claude: paid usage beyond the plan. */
  extra?: { enabled: boolean; monthlyLimit?: number; used?: number; currency?: string };
  /** Codex: ChatGPT credits left (used once the limits are reached). */
  credits?: number;
  error?: string;
  /** Unix ms. */
  queriedAt: number;
}

export interface SubscriptionUsageOptions {
  /** Default: `$CLAUDE_CONFIG_DIR`, else `~/.claude`. */
  claudeDir?: string;
  /** Default: `$CODEX_HOME`, else `~/.codex`. */
  codexHome?: string;
  /** Read macOS's keychain (default: on macOS). */
  keychain?: boolean;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export async function readSubscriptionUsage(agent: UsageAgent, options: SubscriptionUsageOptions = {}): Promise<SubscriptionUsage> {
  try {
    return agent === "claude" ? await claudeUsage(options) : await codexUsage(options);
  } catch (error) {
    return failed(agent, "error", error instanceof Error ? error.message : String(error));
  }
}

function failed(agent: UsageAgent, status: SubscriptionUsage["status"], error?: string): SubscriptionUsage {
  return { agent, status, windows: [], ...(error !== undefined ? { error } : {}), queriedAt: Date.now() };
}

// ── Claude Code ──────────────────────────────────────────────────────────────────────────────────────────────────

interface ClaudeSignIn {
  token: string;
  status: "ok" | "expired" | "refresh_pending";
  plan?: string;
}

async function claudeUsage(options: SubscriptionUsageOptions): Promise<SubscriptionUsage> {
  const signIn = await claudeSignIn(options);
  if (signIn === undefined) return failed("claude", "signed_out");
  const response = await get(options, "https://api.anthropic.com/api/oauth/usage", {
    Authorization: `Bearer ${signIn.token}`,
    "anthropic-beta": "oauth-2025-04-20",
    Accept: "application/json",
  });
  if (response.status === 401 || response.status === 403) {
    return { ...failed("claude", signIn.status === "ok" ? "expired" : signIn.status), ...(signIn.plan !== undefined ? { plan: signIn.plan } : {}) };
  }
  if (!response.ok) return failed("claude", "error", `HTTP ${response.status}`);
  const body = (await response.json()) as Record<string, unknown>;
  return { ...readClaudeUsage(body), ...(signIn.plan !== undefined ? { plan: signIn.plan } : {}) };
}

async function claudeSignIn(options: SubscriptionUsageOptions): Promise<ClaudeSignIn | undefined> {
  if (options.keychain ?? process.platform === "darwin") {
    const user = os.userInfo().username;
    for (const account of [user, undefined]) {
      const text = await keychain("Claude Code-credentials", account);
      const read = text !== undefined ? readClaudeCredentials(text) : undefined;
      if (read !== undefined) return read;
    }
  }
  const dir = options.claudeDir ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  const text = await readFile(path.join(dir, ".credentials.json"), "utf8").catch(() => undefined);
  return text !== undefined ? readClaudeCredentials(text) : undefined;
}

export function readClaudeCredentials(text: string): ClaudeSignIn | undefined {
  const json = parse(text);
  const entry = record(json?.claudeAiOauth ?? json?.["claude.ai_oauth"]);
  const token = typeof entry?.accessToken === "string" ? entry.accessToken : "";
  if (entry === undefined || token === "") return undefined;
  const plan = claudePlan(entry.subscriptionType, entry.rateLimitTier);
  let status: ClaudeSignIn["status"] = "ok";
  if (expired(entry.expiresAt)) {
    const refreshable = typeof entry.refreshToken === "string" && entry.refreshToken !== "" && !expired(entry.refreshTokenExpiresAt);
    status = refreshable ? "refresh_pending" : "expired";
  }
  return { token, status, ...(plan !== undefined ? { plan } : {}) };
}

/** `max` with `default_claude_max_20x` → "Max 20x". */
function claudePlan(type: unknown, tier: unknown): string | undefined {
  if (typeof type !== "string" || type.trim() === "") return undefined;
  const name = titleCase(type);
  const multiple = typeof tier === "string" ? /(\d+x)\b/iu.exec(tier)?.[1] : undefined;
  return multiple !== undefined ? `${name} ${multiple.toLowerCase()}` : name;
}

const CLAUDE_WINDOWS = ["five_hour", "seven_day", "seven_day_fable", "seven_day_opus", "seven_day_sonnet"];

export function readClaudeUsage(body: Record<string, unknown>): SubscriptionUsage {
  const windows: UsageWindow[] = [];
  const seen = new Set<string>();
  const add = (name: string, used: unknown, resets: unknown) => {
    if (typeof used !== "number" || !Number.isFinite(used) || seen.has(name)) return;
    seen.add(name);
    windows.push({ name, usedPercent: used, ...(typeof resets === "string" ? { resetsAt: resets } : {}) });
  };
  for (const name of CLAUDE_WINDOWS) {
    const window = record(body[name]);
    add(name, window?.utilization, window?.resets_at);
  }
  for (const [name, value] of Object.entries(body)) {
    if (name === "extra_usage" || name === "limits") continue;
    const window = record(value);
    add(name, window?.utilization, window?.resets_at);
  }
  // Newer answers name the model of a weekly limit in `limits[]` (with `percent`).
  for (const limit of Array.isArray(body.limits) ? body.limits : []) {
    const each = record(limit);
    if (each?.kind !== "weekly_scoped" || each.group !== "weekly" || record(each.scope)?.surface != null) continue;
    const model = record(record(each.scope)?.model)?.display_name;
    const name = typeof model === "string" ? `seven_day_${model.trim().toLowerCase()}` : undefined;
    if (name === undefined || !CLAUDE_WINDOWS.includes(name)) continue;
    add(name, each.percent, each.resets_at);
  }
  const extra = record(body.extra_usage);
  return {
    agent: "claude",
    status: "ok",
    windows,
    ...(extra !== undefined && typeof extra.is_enabled === "boolean"
      ? {
          extra: {
            enabled: extra.is_enabled,
            ...(typeof extra.monthly_limit === "number" ? { monthlyLimit: extra.monthly_limit } : {}),
            ...(typeof extra.used_credits === "number" ? { used: extra.used_credits } : {}),
            ...(typeof extra.currency === "string" ? { currency: extra.currency } : {}),
          },
        }
      : {}),
    queriedAt: Date.now(),
  };
}

// ── Codex ────────────────────────────────────────────────────────────────────────────────────────────────────────

async function codexUsage(options: SubscriptionUsageOptions): Promise<SubscriptionUsage> {
  const home = options.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  let text: string | undefined;
  if (options.keychain ?? process.platform === "darwin") {
    const canonical = await realpath(home).catch(() => home);
    const account = `cli|${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`;
    text = await keychain("Codex Auth", account);
  }
  text ??= await readFile(path.join(home, "auth.json"), "utf8").catch(() => undefined);
  const auth = text !== undefined ? parse(text) : undefined;
  // Signed in with an API key, or not at all: there is no plan to read.
  if (auth === undefined || auth.auth_mode !== "chatgpt") return failed("codex", "signed_out");
  const tokens = record(auth.tokens);
  const token = typeof tokens?.access_token === "string" ? tokens.access_token : "";
  if (token === "") return failed("codex", "signed_out");
  const accountId = typeof tokens?.account_id === "string" ? tokens.account_id : undefined;
  const response = await get(options, "https://chatgpt.com/backend-api/wham/usage", {
    Authorization: `Bearer ${token}`,
    "User-Agent": "codex-cli",
    Accept: "application/json",
    ...(accountId !== undefined ? { "ChatGPT-Account-Id": accountId } : {}),
  });
  if (response.status === 401 || response.status === 403) return failed("codex", "expired");
  if (!response.ok) return failed("codex", "error", `HTTP ${response.status}`);
  return readCodexUsage((await response.json()) as Record<string, unknown>);
}

export function readCodexUsage(body: Record<string, unknown>): SubscriptionUsage {
  const windows: UsageWindow[] = [];
  const limits = record(body.rate_limit);
  for (const key of ["primary_window", "secondary_window"]) {
    const window = record(limits?.[key]);
    if (window === undefined || typeof window.used_percent !== "number") continue;
    const seconds = typeof window.limit_window_seconds === "number" ? window.limit_window_seconds : undefined;
    const resets = typeof window.reset_at === "number" && window.used_percent > 0 ? new Date(window.reset_at * 1000).toISOString() : undefined;
    windows.push({ name: seconds !== undefined ? windowName(seconds) : key, usedPercent: window.used_percent, ...(resets !== undefined ? { resetsAt: resets } : {}) });
  }
  const plan = typeof body.plan_type === "string" ? codexPlan(body.plan_type) : undefined;
  const credits = codexCredits(record(body.credits));
  return {
    agent: "codex",
    status: "ok",
    windows,
    ...(plan !== undefined ? { plan } : {}),
    ...(credits !== undefined ? { credits } : {}),
    queriedAt: Date.now(),
  };
}

/** Named like Claude's windows, so they read the same. */
function windowName(seconds: number): string {
  if (seconds === 18_000) return "five_hour";
  if (seconds === 604_800) return "seven_day";
  if (seconds === 2_592_000) return "30_day";
  const hours = Math.floor(seconds / 3600);
  return hours >= 24 ? `${Math.floor(hours / 24)}_day` : `${hours}_hour`;
}

/** As Codex's own `/status` names them. */
function codexPlan(type: string): string | undefined {
  const plan = type.trim().toLowerCase();
  const known: Record<string, string> = {
    free: "Free",
    go: "Go",
    plus: "Plus",
    prolite: "Pro 100",
    pro: "Pro 200",
    promax: "Pro 500",
    team: "Business",
    self_serve_business_usage_based: "Business",
    self_serve_business_prolite: "Business Premium",
    edu: "Edu",
    edu_plus: "Edu Plus",
    edu_pro: "Edu Pro",
  };
  if (plan === "" || plan === "unknown") return undefined;
  if (known[plan] !== undefined) return known[plan];
  if (plan === "business" || plan === "ent26" || plan.startsWith("enterprise")) return "Enterprise";
  return titleCase(plan);
}

function codexCredits(credits: Record<string, unknown> | undefined): number | undefined {
  if (credits?.has_credits !== true || credits.unlimited === true) return undefined;
  const balance = typeof credits.balance === "number" ? credits.balance : typeof credits.balance === "string" ? Number(credits.balance.trim()) : NaN;
  return Number.isFinite(balance) && balance > 0 ? balance : undefined;
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** A password of macOS's keychain read with `security`, as the agents store them (so no dialog asks for access). */
function keychain(service: string, account: string | undefined): Promise<string | undefined> {
  const args = ["find-generic-password", "-s", service, ...(account !== undefined ? ["-a", account] : []), "-w"];
  return new Promise((resolve) => {
    execFile("security", args, { timeout: 5000 }, (error, stdout) => {
      if (error) {
        // Not there (exit code 44), or not readable: either way the file is tried next.
        resolve(undefined);
        return;
      }
      const text = stdout.trim();
      resolve(text === "" ? undefined : text);
    });
  });
}

async function get(options: SubscriptionUsageOptions, url: string, headers: Record<string, string>): Promise<Response> {
  const doFetch = options.fetch ?? fetch;
  return doFetch(url, { headers, signal: AbortSignal.timeout(options.timeoutMs ?? 15_000) });
}

function parse(text: string): Record<string, unknown> | undefined {
  try {
    return record(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** A time (ms or s since 1970, or ISO 8601) that has passed; one that cannot be read has not. */
function expired(value: unknown): boolean {
  const now = Date.now();
  if (typeof value === "number") return (value > 1e12 ? value : value * 1000) < now;
  if (typeof value === "string") {
    const time = Date.parse(value);
    return Number.isFinite(time) && time < now;
  }
  return false;
}

function titleCase(raw: string): string {
  return raw
    .split(/[_\- ]+/u)
    .filter((word) => word !== "")
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}
