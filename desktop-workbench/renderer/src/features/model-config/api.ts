import { ApiClient, apiClient } from "@/lib/api";
import type {
  ModelChannel,
  ModelChannelState,
  ModelConfigOverview,
  ModelOffer,
  ModelPreferences,
  ModelProfile,
  TokensLinkStatus,
} from "@/features/dashboard/types";

export type ModelTarget = { connectorId: string; runtimeId: string };

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

/** With just `baseUrl` the server asks the gateway which protocols and models it has. */
export type ManualProfileInput = { name: string; apiKey: string } & ({ baseUrl: string } | { offers: ModelOffer[] });

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
    patch: Partial<{ name: string; apiKey: string; offers: ModelOffer[] }>,
  ): Promise<ModelProfile> {
    return this.client.patch<ModelProfile>(`/model-profiles/${encodeURIComponent(profile.id)}`, patch, {
      token,
      headers: { "If-Match": profile.etag },
    });
  }

  deleteProfile(token: string, profileId: string): Promise<void> {
    return this.client.delete<void>(`/model-profiles/${encodeURIComponent(profileId)}`, { token });
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

  /** Refused with `channel_in_use` while a runtime wants or uses the Anywhere channel. */
  unlinkTokens(token: string): Promise<{ revoked: boolean }> {
    return this.client.delete("/integrations/tokens/link", { token });
  }

  /** The current channel and every runtime's progress switching to the channel it should use. */
  channel(token: string): Promise<ModelChannelState> {
    return this.client.get<ModelChannelState>("/model-config/channel", { token });
  }

  /** Sets the current channel; runtimes switch in the background. */
  setChannel(token: string, channel: ModelChannel): Promise<ModelChannelState> {
    return this.client.put<ModelChannelState>("/model-config/channel", { channel }, { token });
  }

  /** One runtime's own channel; `null` follows the current channel. */
  setRuntimeChannel(
    token: string,
    target: ModelTarget,
    channel: ModelChannel | null,
    confirmNativeGlobal = false,
  ): Promise<ModelChannelState> {
    return this.client.put<ModelChannelState>(
      `/model-config/channel/runtimes/${encodeURIComponent(target.connectorId)}/${encodeURIComponent(target.runtimeId)}`,
      confirmNativeGlobal ? { channel, confirmNativeGlobal: true } : { channel },
      { token },
    );
  }

  /** Tries the runtimes that failed to switch again: all of them, or just one. */
  retryChannel(token: string, target?: ModelTarget): Promise<ModelChannelState> {
    return this.client.post<ModelChannelState>(
      "/model-config/channel/retry",
      target ? { connectorId: target.connectorId, runtimeId: target.runtimeId } : {},
      { token },
    );
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

  /** The old key stops working at once, so a busy runtime refuses it unless interrupting is allowed. */
  rotateTokensKey(token: string, profileId: string, allowInterrupt: boolean): Promise<unknown> {
    return this.client.post(`/model-profiles/${encodeURIComponent(profileId)}/rotate-key`, { allowInterrupt }, { token });
  }
}

export const modelConfigApi = new ModelConfigApi();
