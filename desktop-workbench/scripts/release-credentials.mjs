/**
 * Environment-driven signing and notarization selection for `dist:mac` /
 * `dist:win`.
 *
 * The rules follow the DSH desktop release scripts:
 *
 * - a credential group is all-or-nothing, so a half-configured release fails
 *   before a single file is packaged
 * - signing material is stripped from build and test subprocesses and is only
 *   handed to electron-builder, which is the only step that needs it
 * - no credentials at all is not an error: the artifact is simply unsigned and
 *   the caller logs which step was skipped
 */

const P12_DATA_PREFIX = "data:application/x-pkcs12;base64,";
const DEVELOPER_ID_PREFIX = "Developer ID Application:";
const APPLE_DEVELOPMENT_PREFIX = "Apple Development:";

/** Variables that must never reach a build or test subprocess. */
export const RELEASE_SECRET_VARIABLES = [
  "APPLE_API_ISSUER", "APPLE_API_KEY", "APPLE_API_KEY_ID",
  "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_ID", "APPLE_KEYCHAIN",
  "APPLE_KEYCHAIN_PROFILE", "APPLE_TEAM_ID",
  "CSC_KEY_PASSWORD", "CSC_LINK", "CSC_NAME",
  "CSC_INSTALLER_KEY_PASSWORD", "CSC_INSTALLER_LINK",
  "MAC_CERT_P12_BASE64", "MACOS_SIGN_IDENTITY",
  "WIN_CERT_P12_BASE64", "WIN_CSC_KEY_PASSWORD", "WIN_CSC_LINK",
];

function value(env, name) {
  const trimmed = env[name]?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

function requireTogether(env, names, label) {
  const present = names.filter((name) => value(env, name) !== undefined);
  if (present.length === 0) return undefined;
  if (present.length !== names.length) {
    const missing = names.filter((name) => !present.includes(name));
    throw new Error(`Incomplete ${label}: missing ${missing.join(", ")}`);
  }
  return present;
}

function normalizeP12Base64(raw, name) {
  const compact = raw.replaceAll(/\s/g, "");
  if (
    compact.length === 0
    || compact.length % 4 !== 0
    || !/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/.test(compact)
  ) {
    throw new Error(`${name} must contain a Base64-encoded PKCS#12 file`);
  }
  if (Buffer.from(compact, "base64")[0] !== 0x30) {
    throw new Error(`${name} must contain a Base64-encoded PKCS#12 file`);
  }
  return compact;
}

/** electron-builder wants the identity without its certificate-type prefix. */
function electronBuilderIdentity(identity) {
  return identity.startsWith(DEVELOPER_ID_PREFIX)
    ? identity.slice(DEVELOPER_ID_PREFIX.length).trim()
    : identity;
}

function resolveMacSigning(env, adapted) {
  const p12 = value(env, "MAC_CERT_P12_BASE64");
  const identity = value(env, "MACOS_SIGN_IDENTITY");
  if (p12 !== undefined || identity !== undefined) {
    if (p12 === undefined) throw new Error("Incomplete macOS signing credentials: missing MAC_CERT_P12_BASE64");
    if (identity === undefined) throw new Error("Incomplete macOS signing credentials: missing MACOS_SIGN_IDENTITY");
    if (value(env, "CSC_KEY_PASSWORD") === undefined) {
      throw new Error("Incomplete macOS signing credentials: missing CSC_KEY_PASSWORD");
    }
    if (!identity.startsWith(DEVELOPER_ID_PREFIX)) {
      throw new Error("MACOS_SIGN_IDENTITY must select a Developer ID Application identity");
    }
    if (value(env, "CSC_LINK") !== undefined) {
      throw new Error("Set MAC_CERT_P12_BASE64 or CSC_LINK for macOS signing, not both");
    }
    const configured = value(env, "CSC_NAME");
    const builderIdentity = electronBuilderIdentity(identity);
    if (configured !== undefined && configured !== identity && configured !== builderIdentity) {
      throw new Error("MACOS_SIGN_IDENTITY and CSC_NAME select different signing identities");
    }
    adapted.CSC_LINK = `${P12_DATA_PREFIX}${normalizeP12Base64(p12, "MAC_CERT_P12_BASE64")}`;
    adapted.CSC_NAME = builderIdentity;
    return { source: "p12", identity };
  }

  const cscLink = value(env, "CSC_LINK");
  if (cscLink !== undefined) {
    if (value(env, "CSC_KEY_PASSWORD") === undefined) {
      throw new Error("CSC_KEY_PASSWORD is required when CSC_LINK supplies a macOS signing certificate");
    }
    const configured = value(env, "CSC_NAME");
    if (configured?.startsWith(APPLE_DEVELOPMENT_PREFIX) === true) {
      throw new Error("CSC_NAME must select a Developer ID Application identity");
    }
    return { source: "p12", identity: configured ?? "CSC_LINK" };
  }

  const configured = value(env, "CSC_NAME") ?? identity;
  if (configured?.startsWith(APPLE_DEVELOPMENT_PREFIX) === true) {
    throw new Error("CSC_NAME must select a Developer ID Application identity");
  }
  if (configured !== undefined) {
    const normalized = configured.startsWith(DEVELOPER_ID_PREFIX) ? configured : `${DEVELOPER_ID_PREFIX} ${configured}`;
    adapted.CSC_NAME = electronBuilderIdentity(normalized);
    return { source: "keychain", identity: normalized };
  }
  return { source: "keychain", identity: null };
}

function resolveMacNotarization(env) {
  if (requireTogether(env, ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"], "macOS notarization credentials (Apple ID)")) {
    return "apple-id";
  }
  if (requireTogether(env, ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"], "macOS notarization credentials (App Store Connect API key)")) {
    return "api-key";
  }
  if (value(env, "APPLE_KEYCHAIN_PROFILE") !== undefined) return "keychain-profile";
  if (value(env, "APPLE_KEYCHAIN") !== undefined) {
    throw new Error("Incomplete macOS notarization credentials: missing APPLE_KEYCHAIN_PROFILE");
  }
  return "none";
}

/**
 * Read the macOS release environment.
 * @param env - Process environment, or a test fixture.
 * @returns The electron-builder environment plus a non-secret summary.
 */
export function readMacReleaseCredentials(env) {
  const adapted = { ...env };
  const disabled = value(env, "CSC_IDENTITY_AUTO_DISCOVERY") === "false";
  if (disabled) {
    return {
      environment: adapted,
      signing: { source: "none", identity: null },
      notarization: "none",
      reason: "CSC_IDENTITY_AUTO_DISCOVERY=false",
    };
  }
  const signing = resolveMacSigning(env, adapted);
  const notarization = resolveMacNotarization(env);
  if (notarization !== "none" && signing.source === "none") {
    throw new Error("macOS notarization credentials were provided without a signing identity");
  }
  return { environment: adapted, signing, notarization, reason: null };
}

/**
 * Read the Windows release environment.
 * @param env - Process environment, or a test fixture.
 * @returns The electron-builder environment plus a non-secret summary.
 */
export function readWindowsReleaseCredentials(env) {
  const adapted = { ...env };
  const p12 = value(env, "WIN_CERT_P12_BASE64");
  let signing;
  if (p12 !== undefined) {
    if (value(env, "WIN_CSC_KEY_PASSWORD") === undefined) {
      throw new Error("Incomplete Windows signing credentials: missing WIN_CSC_KEY_PASSWORD");
    }
    if (value(env, "WIN_CSC_LINK") !== undefined) {
      throw new Error("Set WIN_CERT_P12_BASE64 or WIN_CSC_LINK for Windows signing, not both");
    }
    adapted.WIN_CSC_LINK = `${P12_DATA_PREFIX}${normalizeP12Base64(p12, "WIN_CERT_P12_BASE64")}`;
    signing = { source: "p12", identity: "WIN_CSC_LINK" };
  } else if (value(env, "WIN_CSC_LINK") !== undefined) {
    if (value(env, "WIN_CSC_KEY_PASSWORD") === undefined) {
      throw new Error("WIN_CSC_KEY_PASSWORD is required when WIN_CSC_LINK supplies a Windows signing certificate");
    }
    signing = { source: "p12", identity: "WIN_CSC_LINK" };
  } else if (value(env, "CSC_LINK") !== undefined) {
    if (value(env, "CSC_KEY_PASSWORD") === undefined) {
      throw new Error("CSC_KEY_PASSWORD is required when CSC_LINK supplies a Windows signing certificate");
    }
    signing = { source: "p12", identity: "CSC_LINK" };
  } else {
    if (value(env, "WIN_CSC_KEY_PASSWORD") !== undefined) {
      throw new Error("Incomplete Windows signing credentials: missing WIN_CSC_LINK");
    }
    signing = { source: "none", identity: null };
  }
  return { environment: adapted, signing, notarization: "none", reason: null };
}

/**
 * Extract the Developer ID Application identities from `security find-identity`.
 * @param output - Standard output of the codesigning identity listing.
 * @returns Every Developer ID Application identity, in the listed order.
 */
export function parseDeveloperIdIdentities(output) {
  return [...`${output}`.matchAll(/"(Developer ID Application:[^"]+)"/g)].map((match) => match[1]);
}

/**
 * Apply a Keychain lookup to an auto-discovery result.
 *
 * electron-builder's auto-discovery picks any valid certificate, including an
 * Apple Development one, which cannot notarize and Gatekeeper rejects on other
 * machines. A release therefore signs only with a Developer ID Application
 * identity and stays unsigned otherwise.
 *
 * @param credentials - Result of `readMacReleaseCredentials`.
 * @param identity - Developer ID Application identity, or null when none exists.
 * @returns The credentials to package with.
 */
export function applyKeychainIdentity(credentials, identity) {
  if (credentials.signing.source !== "keychain" || credentials.signing.identity !== null) return credentials;
  if (identity === null) {
    return {
      ...credentials,
      environment: { ...credentials.environment, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
      signing: { source: "none", identity: null },
      reason: "no Developer ID Application identity in the Keychain",
    };
  }
  return {
    ...credentials,
    environment: { ...credentials.environment, CSC_NAME: electronBuilderIdentity(identity) },
    signing: { source: "keychain", identity },
  };
}

/**
 * Clone an environment without any recognized release secret.
 * @param env - Environment that may contain release credentials.
 * @returns A copy safe for build and test subprocesses.
 */
export function withoutReleaseSecrets(env) {
  const sanitized = { ...env };
  const known = new Set(RELEASE_SECRET_VARIABLES);
  for (const key of Object.keys(sanitized)) {
    if (known.has(key.toUpperCase())) delete sanitized[key];
  }
  return sanitized;
}
