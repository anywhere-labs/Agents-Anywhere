import { normalizeEmail } from "./account-profile";
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
  ChangePasswordRequest,
  AuthPasswordSaltResponse,
  AuthResponse,
  InstanceSettings,
  EmailSettingsUpdate,
  OAuthProviderConfigUpdate,
  OAuthAuthorizePayload,
  OAuthAuthorizeResponse,
  OAuthFinalizePayload,
  OAuthFinalizeResponse,
  OAuthStartResponse,
  ServiceInfo,
  UserRole,
  MobileLoginQrCreateResponse,
  MobileLoginStatusResponse
} from "@/features/auth/types";

export class AuthApi {
  constructor(private readonly client: ApiClient = apiClient) {}

  config(): Promise<AuthConfig> {
    return this.client.get<AuthConfig>("/auth/config", { auth: false });
  }

  passwordSalt(email: string): Promise<AuthPasswordSaltResponse> {
    return this.client.post<AuthPasswordSaltResponse>(
      "/auth/password-salt",
      { email: normalizeEmail(email) },
      { auth: false },
    );
  }

  async login(credentials: AuthCredentials): Promise<AuthResponse> {
    const email = normalizeEmail(credentials.email);
    const passwordVerifier =
      credentials.passwordVerifier ??
      (credentials.password
        ? await this.loginPasswordVerifier(email, credentials.password)
        : undefined);

    return this.client.post<AuthResponse>(
      "/auth/login",
      {
        email,
        passwordVerifier
      },
      { auth: false },
    );
  }

  async register(credentials: AuthCredentials): Promise<AuthResponse> {
    const email = normalizeEmail(credentials.email);
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
        email,
        displayName: credentials.displayName?.trim(),
        ...(credentials.code ? { code: credentials.code } : {}),
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

  authorizeOAuth(token: string, payload: OAuthAuthorizePayload): Promise<OAuthAuthorizeResponse> {
    return this.client.post<OAuthAuthorizeResponse>(
      "/oauth/authorize",
      payload,
      { token },
    );
  }

  async finalizeOAuth(payload: OAuthFinalizePayload): Promise<OAuthFinalizeResponse> {
    let body = { ...payload, ...(payload.email ? { email: normalizeEmail(payload.email) } : {}), ...(payload.displayName ? { displayName: payload.displayName.trim() } : {}) };
    if (payload.password) {
      const { password: _password, ...rest } = body;
      if (payload.setPassword) {
        body = {
          ...rest,
          ...(await createPasswordVerifier(payload.password))
        };
      } else {
        const email = payload.email;
        if (!email) {
          throw new Error("OAuth password confirmation requires an email address.");
        }
        body = {
          ...rest,
          passwordVerifier: await this.loginPasswordVerifier(email, payload.password)
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

  async changePassword(
    token: string,
    body: { newPassword?: string; newPasswordVerifier?: string; newPasswordSalt?: string },
  ): Promise<void> {
    let verifier: ChangePasswordRequest = {};
    if (body.newPasswordVerifier && body.newPasswordSalt) {
      verifier = { newPasswordVerifier: body.newPasswordVerifier, newPasswordSalt: body.newPasswordSalt };
    } else if (body.newPassword) {
      const created = await createPasswordVerifier(body.newPassword);
      verifier = {
        newPasswordVerifier: created.passwordVerifier,
        newPasswordSalt: created.passwordSalt,
      };
    }
    return this.client.post<void>(
      "/auth/change-password",
      verifier,
      { token },
    );
  }

  sendEmailCode(email: string, purpose: "register" | "bind", token?: string, pendingToken?: string, setupToken?: string): Promise<{ expiresIn: number; retryAfter: number }> {
    return this.client.post("/auth/email-code", { email: normalizeEmail(email), purpose, ...(pendingToken ? { pendingToken } : {}), ...(setupToken ? { setupToken } : {}) }, { auth: false, token });
  }

  updateEmail(token: string, email: string, code?: string): Promise<AuthMe> {
    return this.client.put("/auth/me/email", { email: normalizeEmail(email), ...(code ? { code } : {}) }, { token });
  }

  updateProfile(token: string, displayName: string): Promise<AuthMe> {
    return this.client.put("/auth/me/profile", { displayName: displayName.trim() }, { token });
  }

  updateAvatar(token: string, avatar: string): Promise<AuthMe> {
    return this.client.put<AuthMe>("/auth/me/avatar", { avatar }, { token });
  }

  clearAvatar(token: string): Promise<AuthMe> {
    return this.client.delete<AuthMe>("/auth/me/avatar", { token });
  }

  listUsers(token: string): Promise<AdminUserListResponse> {
    return this.client.get<AdminUserListResponse>("/admin/users", { token });
  }

  async createUser(
    token: string,
    body: {
      email: string;
      displayName: string;
      code?: string;
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
        email: normalizeEmail(body.email),
        displayName: body.displayName.trim(),
        ...(body.code ? { code: body.code } : {}),
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
      displayName?: string;
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
        ...(body.displayName !== undefined ? { displayName: body.displayName.trim() } : {}),
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
      email?: EmailSettingsUpdate;
    },
  ): Promise<InstanceSettings> {
    return this.client.patch<InstanceSettings>("/admin/settings", body, { token });
  }

  getServiceInfo(token: string): Promise<ServiceInfo> {
    return this.client.get<ServiceInfo>("/admin/service", { token });
  }

  private async loginPasswordVerifier(email: string, password: string): Promise<string> {
    const { salt } = await this.passwordSalt(email);
    return derivePasswordVerifier(password, salt);
  }

  createMobileLoginQr(token: string): Promise<MobileLoginQrCreateResponse> {
    return this.client.post<MobileLoginQrCreateResponse>("/auth/mobile-login/qr", {}, { token });
  }

  mobileLoginStatus(token: string, loginToken: string): Promise<MobileLoginStatusResponse> {
    return this.client.post<MobileLoginStatusResponse>("/auth/mobile-login/status", { loginToken }, { token });
  }

  confirmMobileLogin(token: string, loginToken: string, approved: boolean): Promise<MobileLoginStatusResponse> {
    return this.client.post<MobileLoginStatusResponse>("/auth/mobile-login/confirm", { loginToken, approved }, { token });
  }
}
export const authApi = new AuthApi();

export { normalizeEmail } from "./account-profile";
