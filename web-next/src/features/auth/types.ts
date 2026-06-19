export type UserRole = "admin" | "member";

export type AuthConfig = {
  needsBootstrap: boolean;
  registrationOpen: boolean;
  oauthRegistrationOpen: boolean;
  oauthEnabled: boolean;
  oauthProviderLabel: string | null;
  setupTokenExpiresAt: string | null;
  serverTime: string;
};

export type AuthResponse = {
  userId: string;
  role: UserRole;
  accessToken: string;
  tokenType: string;
  serverTime: string;
};

export type AuthMe = {
  userId: string;
  role: UserRole;
  disabled: boolean;
  avatar: string | null;
  serverTime: string;
};

export type AuthCredentials = {
  userId: string;
  password?: string;
  passwordVerifier?: string;
  passwordSalt?: string;
  setupToken?: string;
};

export type AuthPasswordSaltResponse = {
  salt: string;
  serverTime: string;
};

export type OAuthStartResponse = {
  authorizeUrl: string;
  serverTime: string;
};

export type OAuthFinalizePayload = {
  pendingToken: string;
  userId?: string;
  password?: string;
  passwordVerifier?: string;
  passwordSalt?: string;
  setPassword?: boolean;
};

export type OAuthFinalizeResponse = {
  auth: AuthResponse;
  serverTime: string;
};

export type StoredSession = {
  accessToken: string;
  userId: string;
  role: UserRole;
};
