export type DesktopProductMetadata = {
  productVersion: string;
  versionCode: number;
};

export function parseDesktopProductMetadata(value: unknown): DesktopProductMetadata {
  if (!value || typeof value !== "object") {
    throw new Error("Desktop product metadata is missing.");
  }
  const candidate = value as Partial<DesktopProductMetadata>;
  const productVersion = typeof candidate.productVersion === "string"
    ? candidate.productVersion.trim()
    : "";
  const versionCode = Number(candidate.versionCode);
  if (!isNumericProductVersion(productVersion)) {
    throw new Error("Desktop productVersion must contain dot-separated numeric components.");
  }
  if (!Number.isSafeInteger(versionCode) || versionCode < 1) {
    throw new Error("Desktop versionCode must be a positive integer.");
  }
  return { productVersion, versionCode };
}

export function compareProductVersions(left: string, right: string): number {
  const leftParts = numericVersionParts(left);
  const rightParts = numericVersionParts(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

export function isNumericProductVersion(value: string): boolean {
  const normalized = value.trim();
  return /^\d+(?:\.\d+)*$/.test(normalized) &&
    normalized.split(".").every((part) => Number.isSafeInteger(Number(part)));
}

function numericVersionParts(value: string): number[] {
  const normalized = value.trim();
  if (!isNumericProductVersion(normalized)) {
    throw new Error(`Invalid product version: ${normalized || "<empty>"}`);
  }
  return normalized.split(".").map((part) => Number(part));
}
