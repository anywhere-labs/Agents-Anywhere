import { ApiClient, apiClient } from "@/lib/api";
import type {
  ModelAssignment,
  ModelConfigOverview,
  ModelOffer,
  ModelPreferences,
  ModelProfile,
  ModelProtocol,
  RuntimeMaturity,
  TokensLinkStatus,
} from "@/features/dashboard/types";

export type ModelTarget = { connectorId: string; runtimeId: string };

export type ModelPreviewTarget = ModelTarget & {
  runtimeType: string;
  name: string | null;
  maturity: RuntimeMaturity | null;
  decision: "apply" | "skip";
  reason?: string;
  offerFormat?: ModelProtocol;
  effect?: "new_instance" | "immediate" | "new_session" | "restart";
  scope?: "instance" | "session" | "native_global";
  requiresConfirmation?: boolean;
  runningSessions?: number;
  replaces?: { kind: "profile" | "manual"; profileId: string | null; host: string } | null;
  models?: { importing: number; existing: number; limit: number };
  tooManyModels?: boolean;
  capabilityMaturity?: RuntimeMaturity | null;
};

export type ModelOperationResult = ModelTarget & {
  result: "applied" | "skipped" | "failed" | "restored";
  reason?: string;
  message?: string;
  createdRuntime?: boolean;
  servesRuntimeId?: string;
};

export type ModelOperation = {
  operationId: string | null;
  kind: string;
  finished: boolean;
  results: ModelOperationResult[];
};

/** Amounts are decimal yuan strings with four places, as Tokens Anywhere sends them. */
export type TokensAccount = {
  account: { id: string; displayName: string | null; email: string | null };
  balance: { balance: string | null; available: string | null; held: string | null; bonus: string | null };
  links: { console: string; billing: string; usage: string };
};

export type TokensUsageItem = {
  date: string;
  model: string | null;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  amountCharged: string;
};

export type TokensUsage = { from: string; to: string; items: TokensUsageItem[] };

/** Where this instance finds Tokens Anywhere; set by an administrator. */
export type TokensAdminSettings = {
  tokensUrl: string | null;
  source: "setting" | "environment" | null;
  linkedAccounts: number;
  secretConfigured: boolean;
};

export type ManualProfileInput = { name: string; apiKey: string; offers: ModelOffer[] };

/** Model profiles and the Tokens Anywhere link. Keys go in and never come back. */
export class ModelConfigApi {
  constructor(private readonly client: ApiClient = apiClient) {}

  overview(token: string): Promise<ModelConfigOverview> {
    return this.client.get<ModelConfigOverview>("/model-profiles", { token });
  }

  createProfile(token: string, input: ManualProfileInput): Promise<ModelProfile> {
    return this.client.post<ModelProfile>("/model-profiles", input, { token });
  }

  updateProfile(
    token: string,
    profile: Pick<ModelProfile, "id" | "etag">,
    patch: Partial<ManualProfileInput>,
  ): Promise<ModelProfile> {
    return this.client.patch<ModelProfile>(`/model-profiles/${encodeURIComponent(profile.id)}`, patch, {
      token,
      headers: { "If-Match": profile.etag },
    });
  }

  deleteProfile(token: string, profileId: string): Promise<void> {
    return this.client.delete<void>(`/model-profiles/${encodeURIComponent(profileId)}`, { token });
  }

  preview(token: string, profileId: string, targets?: ModelTarget[]): Promise<{ profileId: string; targets: ModelPreviewTarget[] }> {
    return this.client.post("/model-config/assignments/preview", { profileId, ...(targets ? { targets } : {}) }, { token });
  }

  apply(
    token: string,
    request: {
      profileId: string;
      targets: ModelTarget[];
      allowInterrupt: boolean;
      confirmNativeGlobal: boolean;
      modelIds?: string[];
    },
    idempotencyKey: string,
  ): Promise<ModelOperation> {
    return this.client.post<ModelOperation>("/model-config/assignments", request, {
      token,
      headers: { "Idempotency-Key": idempotencyKey },
    });
  }

  restore(token: string, assignment: Pick<ModelAssignment, "connectorId" | "runtimeId">, allowInterrupt: boolean): Promise<ModelOperationResult> {
    return this.client.delete<ModelOperationResult>(
      `/model-config/assignments/${encodeURIComponent(assignment.connectorId)}/${encodeURIComponent(assignment.runtimeId)}`,
      { token, query: { allow_interrupt: allowInterrupt } },
    );
  }

  tokensStatus(token: string): Promise<TokensLinkStatus> {
    return this.client.get<TokensLinkStatus>("/integrations/tokens", { token });
  }

  /** A one-time address to open in the browser that authorizes the link. */
  beginTokensLink(token: string): Promise<{ startUrl: string }> {
    return this.client.post<{ startUrl: string }>("/integrations/tokens/link", undefined, { token });
  }

  syncTokens(token: string): Promise<ModelProfile> {
    return this.client.post<ModelProfile>("/integrations/tokens/sync", undefined, { token });
  }

  unlinkTokens(token: string, allowInterrupt: boolean): Promise<{ revoked: boolean; results: ModelOperationResult[] }> {
    return this.client.delete("/integrations/tokens/link", { token, query: { allow_interrupt: allowInterrupt } });
  }

  /** Runtimes a one-click Tokens Anywhere setup would configure, with reasons for the rest. */
  quickSetupCandidates(token: string): Promise<{ targets: ModelPreviewTarget[] }> {
    return this.client.get("/integrations/tokens/quick-setup", { token });
  }

  /** Starts the setup; when the account must link first, returns the address to open. */
  startQuickSetup(
    token: string,
    request: { targets: ModelTarget[]; confirmNativeGlobal: boolean },
  ): Promise<{ started: boolean; startUrl: string | null }> {
    return this.client.post("/integrations/tokens/quick-setup", request, { token });
  }

  /** The linked account, its balance and its console pages. */
  tokensAccount(token: string): Promise<TokensAccount> {
    return this.client.get<TokensAccount>("/integrations/tokens/account", { token });
  }

  /** The whole Tokens account's settled usage over the last `days` Beijing days. */
  tokensUsage(token: string, days: number): Promise<TokensUsage> {
    return this.client.get<TokensUsage>("/integrations/tokens/usage", { token, query: { days } });
  }

  /** Turns models off and renames them; runtimes using Tokens get the change in the background. */
  saveTokensModels(token: string, preferences: ModelPreferences): Promise<{ applying: boolean }> {
    return this.client.put<{ applying: boolean }>("/integrations/tokens/models", preferences, { token });
  }

  adminTokensSettings(token: string): Promise<TokensAdminSettings> {
    return this.client.get<TokensAdminSettings>("/admin/integrations/tokens", { token });
  }

  /** An empty address turns Tokens Anywhere off; refused while accounts are linked to the old one. */
  saveAdminTokensSettings(token: string, tokensUrl: string): Promise<TokensAdminSettings> {
    return this.client.put<TokensAdminSettings>("/admin/integrations/tokens", { tokensUrl: tokensUrl || null }, { token });
  }

  rotateTokensKey(token: string, profileId: string, allowInterrupt: boolean, idempotencyKey: string): Promise<ModelOperation> {
    return this.client.post<ModelOperation>(
      `/model-profiles/${encodeURIComponent(profileId)}/rotate-key`,
      { allowInterrupt },
      { token, headers: { "Idempotency-Key": idempotencyKey } },
    );
  }
}

export const modelConfigApi = new ModelConfigApi();
