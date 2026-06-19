import { ApiClient, apiClient } from "@/lib/api";
import {
  createPasswordVerifier,
  derivePasswordVerifier
} from "@/features/auth/password-verifier";
import type {
  AuthConfig,
  AuthCredentials,
  AuthMe,
  AuthPasswordSaltResponse,
  AuthResponse,
  OAuthFinalizePayload,
  OAuthFinalizeResponse,
  OAuthStartResponse
} from "@/features/auth/types";

export class AuthApi {
  constructor(private readonly client: ApiClient = apiClient) {}

  config(): Promise<AuthConfig> {
    return this.client.get<AuthConfig>("/auth/config", { auth: false });
  }

  passwordSalt(userId: string): Promise<AuthPasswordSaltResponse> {
    return this.client.post<AuthPasswordSaltResponse>(
      "/auth/password-salt",
      { userId },
      { auth: false },
    );
  }

  async login(credentials: AuthCredentials): Promise<AuthResponse> {
    const userId = normalizeUserId(credentials.userId);
    const passwordVerifier =
      credentials.passwordVerifier ??
      (credentials.password
        ? await this.loginPasswordVerifier(userId, credentials.password)
        : undefined);

    return this.client.post<AuthResponse>(
      "/auth/login",
      {
        userId,
        passwordVerifier
      },
      { auth: false },
    );
  }

  async register(credentials: AuthCredentials): Promise<AuthResponse> {
    const userId = normalizeUserId(credentials.userId);
    const verifier =
      credentials.passwordVerifier && credentials.passwordSalt
        ? {
            passwordVerifier: credentials.passwordVerifier,
            passwordSalt: credentials.passwordSalt
          }
        : credentials.password
          ? await createPasswordVerifier(credentials.password)
          : undefined;

    return this.client.post<AuthResponse>(
      "/auth/register",
      {
        userId,
        ...(verifier ?? {}),
        ...(credentials.setupToken ? { setupToken: credentials.setupToken } : {})
      },
      { auth: false },
    );
  }

  startOAuth(returnTo: string): Promise<OAuthStartResponse> {
    return this.client.get<OAuthStartResponse>("/auth/oauth/start", {
      auth: false,
      query: { returnTo }
    });
  }

  async finalizeOAuth(payload: OAuthFinalizePayload): Promise<OAuthFinalizeResponse> {
    let body = payload;
    if (payload.password) {
      if (payload.setPassword) {
        body = {
          ...payload,
          ...(await createPasswordVerifier(payload.password)),
          password: undefined
        };
      } else {
        const userId = payload.userId;
        if (!userId) {
          throw new Error("OAuth password confirmation requires a user ID.");
        }
        body = {
          ...payload,
          passwordVerifier: await this.loginPasswordVerifier(userId, payload.password),
          password: undefined
        };
      }
    }

    return this.client.post<OAuthFinalizeResponse>(
      "/auth/oauth/finalize",
      body,
      { auth: false },
    );
  }

  me(token?: string | null): Promise<AuthMe> {
    return this.client.get<AuthMe>("/auth/me", { token });
  }

  private async loginPasswordVerifier(userId: string, password: string): Promise<string> {
    const { salt } = await this.passwordSalt(userId);
    return derivePasswordVerifier(password, salt);
  }
}

export const authApi = new AuthApi();

export function normalizeUserId(userId: string): string {
  return userId.trim().toLowerCase();
}
