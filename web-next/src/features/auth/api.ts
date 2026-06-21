import { ApiClient, apiClient } from "@/lib/api";
import {
  createPasswordVerifier,
  derivePasswordVerifier
} from "@/features/auth/password-verifier";
import type {
  AdminUser,
  AdminUserListResponse,
  AuthConfig,
  AuthCredentials,
  AuthMe,
  AuthPasswordSaltResponse,
  AuthResponse,
  InstanceSettings,
  OAuthProviderConfigUpdate,
  OAuthFinalizePayload,
  OAuthFinalizeResponse,
  OAuthStartResponse,
  ServiceInfo,
  UserRole
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
      const { password: _password, ...rest } = payload;
      if (payload.setPassword) {
        body = {
          ...rest,
          ...(await createPasswordVerifier(payload.password))
        };
      } else {
        const userId = payload.userId;
        if (!userId) {
          throw new Error("OAuth password confirmation requires a user ID.");
        }
        body = {
          ...rest,
          passwordVerifier: await this.loginPasswordVerifier(userId, payload.password)
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

  listUsers(token: string): Promise<AdminUserListResponse> {
    return this.client.get<AdminUserListResponse>("/admin/users", { token });
  }

  async createUser(
    token: string,
    body: {
      userId: string;
      role: UserRole;
      password?: string;
      passwordVerifier?: string;
      passwordSalt?: string;
    },
  ): Promise<AdminUser> {
    const verifier =
      body.passwordVerifier && body.passwordSalt
        ? { passwordVerifier: body.passwordVerifier, passwordSalt: body.passwordSalt }
        : body.password
          ? await createPasswordVerifier(body.password)
          : {};
    return this.client.post<AdminUser>(
      "/admin/users",
      {
        userId: normalizeUserId(body.userId),
        role: body.role,
        ...verifier,
      },
      { token },
    );
  }

  async updateUser(
    token: string,
    userId: string,
    body: {
      role?: UserRole;
      disabled?: boolean;
      password?: string;
      passwordVerifier?: string;
      passwordSalt?: string;
    },
  ): Promise<AdminUser> {
    const verifier =
      body.passwordVerifier && body.passwordSalt
        ? { passwordVerifier: body.passwordVerifier, passwordSalt: body.passwordSalt }
        : body.password
          ? await createPasswordVerifier(body.password)
          : {};
    return this.client.patch<AdminUser>(
      `/admin/users/${encodeURIComponent(userId)}`,
      {
        ...(body.role ? { role: body.role } : {}),
        ...(typeof body.disabled === "boolean" ? { disabled: body.disabled } : {}),
        ...verifier,
      },
      { token },
    );
  }

  deleteUser(token: string, userId: string): Promise<void> {
    return this.client.delete<void>(`/admin/users/${encodeURIComponent(userId)}`, { token });
  }

  getSettings(token: string): Promise<InstanceSettings> {
    return this.client.get<InstanceSettings>("/admin/settings", { token });
  }

  updateSettings(
    token: string,
    body: {
      registrationOpen?: boolean;
      oauthRegistrationOpen?: boolean;
      oauth?: OAuthProviderConfigUpdate;
    },
  ): Promise<InstanceSettings> {
    return this.client.patch<InstanceSettings>("/admin/settings", body, { token });
  }

  getServiceInfo(token: string): Promise<ServiceInfo> {
    return this.client.get<ServiceInfo>("/admin/service", { token });
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
