import { normalizeEmail } from "./account-profile";
import { ApiClient, apiClient } from "@/lib/api";
import { createPasswordVerifier } from "@/features/auth/password-verifier";
import type {
  AdminUser,
  AdminUserListResponse,
  AuthConfig,
  AuthMe,
  ChangePasswordRequest,
  InstanceSettings,
  EmailSettingsUpdate,
  OAuthProviderConfigUpdate,
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
      email?: EmailSettingsUpdate;
    },
  ): Promise<InstanceSettings> {
    return this.client.patch<InstanceSettings>("/admin/settings", body, { token });
  }

  getServiceInfo(token: string): Promise<ServiceInfo> {
    return this.client.get<ServiceInfo>("/admin/service", { token });
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

export function normalizeUserId(userId: string): string {
  return userId.trim().toLowerCase();
}
