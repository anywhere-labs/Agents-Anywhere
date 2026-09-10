import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { before } from "node:test";
import { pathToFileURL } from "node:url";

// The dist scripts are ESM, while this package compiles to CommonJS.
type ReleaseCredentials = {
  environment: NodeJS.ProcessEnv;
  signing: { source: string; identity: string | null };
  notarization: string;
  reason: string | null;
};
type CredentialApi = {
  readMacReleaseCredentials: (env: NodeJS.ProcessEnv) => ReleaseCredentials;
  readWindowsReleaseCredentials: (env: NodeJS.ProcessEnv) => ReleaseCredentials;
  withoutReleaseSecrets: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  parseDeveloperIdIdentities: (output: string) => string[];
  applyKeychainIdentity: (credentials: ReleaseCredentials, identity: string | null) => ReleaseCredentials;
};
let credentials: CredentialApi;
before(async () => {
  // dist/electron shifts one level deeper than electron/, so resolve at runtime.
  const script = pathToFileURL(resolve(__dirname, "../../scripts/release-credentials.mjs")).href;
  credentials = await import(script);
});

const P12 = `data:application/x-pkcs12;base64,${Buffer.from([0x30, 0x82, 0x01]).toString("base64")}`;

test("macOS signing uses a base64 certificate and never leaks it into the build environment", () => {
  const { readMacReleaseCredentials, withoutReleaseSecrets } = credentials;
  const result = readMacReleaseCredentials({
    PATH: "/usr/bin",
    MAC_CERT_P12_BASE64: Buffer.from([0x30, 0x82, 0x01]).toString("base64"),
    MACOS_SIGN_IDENTITY: "Developer ID Application: Anywhere Labs (TEAM123)",
    CSC_KEY_PASSWORD: "p12-password",
    APPLE_ID: "release@example.test",
    APPLE_APP_SPECIFIC_PASSWORD: "app-password",
    APPLE_TEAM_ID: "TEAM123",
  });

  assert.equal(result.signing.source, "p12");
  assert.equal(result.signing.identity, "Developer ID Application: Anywhere Labs (TEAM123)");
  assert.equal(result.notarization, "apple-id");
  assert.equal(result.environment.CSC_LINK, P12);
  assert.equal(result.environment.CSC_NAME, "Anywhere Labs (TEAM123)");

  const clean = withoutReleaseSecrets(result.environment);
  assert.deepEqual(Object.keys(clean).filter((key) => /CSC|APPLE|P12|IDENTITY/.test(key)), []);
  assert.equal(clean.PATH, "/usr/bin");
});

test("macOS signing accepts a keychain identity and strips the certificate-type prefix", () => {
  const { readMacReleaseCredentials } = credentials;
  const result = readMacReleaseCredentials({
    CSC_NAME: "Developer ID Application: Anywhere Labs (TEAM123)",
    APPLE_KEYCHAIN_PROFILE: "aa-notary",
  });
  assert.equal(result.signing.source, "keychain");
  assert.equal(result.environment.CSC_NAME, "Anywhere Labs (TEAM123)");
  assert.equal(result.notarization, "keychain-profile");
});

test("macOS signing falls back to keychain auto-discovery and skips notarization", () => {
  const { readMacReleaseCredentials } = credentials;
  const result = readMacReleaseCredentials({});
  assert.equal(result.signing.source, "keychain");
  assert.equal(result.signing.identity, null);
  assert.equal(result.notarization, "none");
});

test("an explicit CSC_IDENTITY_AUTO_DISCOVERY=false produces an unsigned build", () => {
  const { readMacReleaseCredentials } = credentials;
  const result = readMacReleaseCredentials({
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
    APPLE_ID: "release@example.test",
  });
  assert.equal(result.signing.source, "none");
  assert.equal(result.reason, "CSC_IDENTITY_AUTO_DISCOVERY=false");
});

test("a partially configured macOS release fails instead of signing with half the credentials", () => {
  const { readMacReleaseCredentials } = credentials;
  assert.throws(() => readMacReleaseCredentials({ APPLE_ID: "release@example.test" }), /missing APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID/);
  assert.throws(() => readMacReleaseCredentials({ APPLE_API_KEY: "/keys/AuthKey.p8" }), /missing APPLE_API_KEY_ID, APPLE_API_ISSUER/);
  assert.throws(() => readMacReleaseCredentials({ MAC_CERT_P12_BASE64: "MIIB" }), /missing MACOS_SIGN_IDENTITY/);
  assert.throws(
    () => readMacReleaseCredentials({ MAC_CERT_P12_BASE64: "MIIB", MACOS_SIGN_IDENTITY: "Developer ID Application: A (B)" }),
    /missing CSC_KEY_PASSWORD/,
  );
  assert.throws(() => readMacReleaseCredentials({ MAC_CERT_P12_BASE64: "not base64" , MACOS_SIGN_IDENTITY: "Developer ID Application: A (B)", CSC_KEY_PASSWORD: "x" }), /Base64-encoded PKCS#12/);
  assert.throws(() => readMacReleaseCredentials({ CSC_LINK: "cert.p12" }), /CSC_KEY_PASSWORD is required/);
  assert.throws(() => readMacReleaseCredentials({ CSC_NAME: "Apple Development: Someone (TEAM123)" }), /Developer ID Application/);
  assert.throws(() => readMacReleaseCredentials({ APPLE_KEYCHAIN: "/tmp/keychain" }), /missing APPLE_KEYCHAIN_PROFILE/);
});

test("Windows signing reads WIN_CSC_LINK and fails on a half-configured certificate", () => {
  const { readWindowsReleaseCredentials } = credentials;
  const configured = readWindowsReleaseCredentials({ WIN_CSC_LINK: "cert.pfx", WIN_CSC_KEY_PASSWORD: "secret" });
  assert.equal(configured.signing.source, "p12");
  assert.equal(configured.signing.identity, "WIN_CSC_LINK");

  const base64 = readWindowsReleaseCredentials({
    WIN_CERT_P12_BASE64: Buffer.from([0x30, 0x82, 0x01]).toString("base64"),
    WIN_CSC_KEY_PASSWORD: "secret",
  });
  assert.equal(base64.environment.WIN_CSC_LINK, P12);

  const unsigned = readWindowsReleaseCredentials({});
  assert.equal(unsigned.signing.source, "none");

  assert.throws(() => readWindowsReleaseCredentials({ WIN_CSC_LINK: "cert.pfx" }), /WIN_CSC_KEY_PASSWORD is required/);
  assert.throws(() => readWindowsReleaseCredentials({ WIN_CSC_KEY_PASSWORD: "secret" }), /missing WIN_CSC_LINK/);
  assert.throws(() => readWindowsReleaseCredentials({ CSC_LINK: "cert.pfx" }), /CSC_KEY_PASSWORD is required/);
});

test("secret stripping is case-insensitive and leaves unrelated variables alone", () => {
  const { withoutReleaseSecrets } = credentials;
  const clean = withoutReleaseSecrets({
    csc_link: "cert.p12",
    Win_Csc_Key_Password: "secret",
    APPLE_TEAM_ID: "TEAM123",
    PATH: "/usr/bin",
  });
  assert.deepEqual(clean, { PATH: "/usr/bin" });
});

test("only Developer ID Application identities are read from the Keychain listing", () => {
  const { parseDeveloperIdIdentities } = credentials;
  const listing = [
    '  1) 74A5637FE31FE6209D35EA7C6C604E5334123897 "Apple Development: someone@example.test (QTFP45954V)"',
    '  2) 6E516DD52771C8476CDED224F2C000454B7F3D84 "Developer ID Application: Anywhere Labs (TEAM123)"',
    '  3) D15542D7A7FB8C258A1432B9435F435681719279 "3rd Party Mac Developer Application: other (UM3Z9G5DNH)"',
    "     3 valid identities found",
  ].join("\n");
  assert.deepEqual(parseDeveloperIdIdentities(listing), ["Developer ID Application: Anywhere Labs (TEAM123)"]);
  assert.deepEqual(parseDeveloperIdIdentities("     0 valid identities found"), []);
});

test("auto-discovery signs only with a Developer ID Application identity", () => {
  const { readMacReleaseCredentials, applyKeychainIdentity } = credentials;
  const discovered = applyKeychainIdentity(readMacReleaseCredentials({}), "Developer ID Application: Anywhere Labs (TEAM123)");
  assert.equal(discovered.signing.source, "keychain");
  assert.equal(discovered.environment.CSC_NAME, "Anywhere Labs (TEAM123)");
});

test("auto-discovery without a Developer ID Application identity stays unsigned", () => {
  const { readMacReleaseCredentials, applyKeychainIdentity } = credentials;
  const unsigned = applyKeychainIdentity(readMacReleaseCredentials({}), null);
  assert.equal(unsigned.signing.source, "none");
  assert.equal(unsigned.environment.CSC_IDENTITY_AUTO_DISCOVERY, "false");
  assert.match(String(unsigned.reason), /no Developer ID Application identity/);
});

test("an explicit certificate is never replaced by the Keychain lookup", () => {
  const { readMacReleaseCredentials, applyKeychainIdentity } = credentials;
  const explicit = readMacReleaseCredentials({ CSC_NAME: "Anywhere Labs (TEAM123)" });
  assert.equal(applyKeychainIdentity(explicit, "Developer ID Application: Someone Else (OTHER)"), explicit);
});

