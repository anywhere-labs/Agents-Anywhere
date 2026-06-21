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

export type OAuthProviderConfig = {
  enabled: boolean;
  provider: string;
  label: string;
  authorizeUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  clientId: string;
  scopes: string;
  usernameClaim: string;
  subjectClaim: string;
  emailClaim: string;
  nameClaim: string;
};

export type OAuthProviderConfigUpdate = OAuthProviderConfig & {
  clientSecret?: string;
};

export type AdminUser = {
  userId: string;
  role: UserRole;
  disabled: boolean;
  avatar: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AdminUserListResponse = {
  users: AdminUser[];
  serverTime: string;
};

export type InstanceSettings = {
  registrationOpen: boolean;
  oauthRegistrationOpen: boolean;
  oauth: OAuthProviderConfig | null;
};

export type ServiceInfo = {
  endpoint: string;
  version: string;
  database: string;
  databasePath: string | null;
  startedAt: string;
  uptimeSeconds: number;
  serverTime: string;
};

export type StoredSession = {
  accessToken: string;
  userId: string;
  role: UserRole;
};
