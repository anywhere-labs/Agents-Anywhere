export interface AuthResponse {
  userId: string;
  email: string | null;
  displayName: string;
  emailVerified: boolean;
  role: string;
  accessToken: string;
  tokenType: string;
  serverTime: string;
}

export interface AuthMeResponse {
  userId: string;
  email: string | null;
  displayName: string;
  emailVerified: boolean;
  role: string;
  disabled: boolean;
  avatar: string | null;
  serverTime: string;
}

export interface AuthConfigResponse {
  needsBootstrap: boolean;
  registrationOpen: boolean;
  oauthRegistrationOpen: boolean;
  oauthEnabled: boolean;
  oauthProviderLabel: string | null;
  setupTokenExpiresAt: string | null;
  serverTime: string;
  emailVerificationRequired: boolean;
}

export interface OAuthTokenResponse {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
  scope: string;
  refreshToken: string | null;
}

// Mobile-login DTOs for the HarmonyOS client live in AuthApi.ets
// (MobileLoginStatus / MobileLoginExchange); the scanned QR payload model lives
// in auth/MobileLoginQrPayload.ets. The login flow in LoginPage.ets consumes
// those via AuthApi.
