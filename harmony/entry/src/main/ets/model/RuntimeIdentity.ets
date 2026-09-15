/**
 * Runtime display identity.
 *
 * Port of `model/RuntimeIdentity.kt`. The labels are what the user reads in a
 * session row and in the device detail list, so the exact fallback order matters.
 */
export interface RuntimeInstanceLabels {
  primary: string;
  /** Null when the type label would repeat `primary`, which Android suppresses. */
  secondary: string | null;
}

/** Human-readable runtime type names. */
export function runtimeTypeLabel(runtimeType: string): string {
  if (runtimeType === 'codex') {
    return 'Codex';
  }
  if (runtimeType === 'claude') {
    return 'Claude Code';
  }
  if (runtimeType === 'dsh') {
    return 'DeepSeek Harness';
  }
  if (runtimeType.length === 0) {
    return runtimeType;
  }
  // Kotlin's `replaceFirstChar { titlecase }` for the unknown case.
  const first: string = runtimeType.charAt(0);
  return first.toUpperCase() + runtimeType.substring(1);
}

/**
 * Resolves the primary/secondary labels for a runtime instance.
 *
 * A blank or type-equal instance name falls back to the type label, and the
 * secondary is dropped when it would duplicate the primary.
 */
export function runtimeInstanceLabels(name: string | null, runtimeType: string): RuntimeInstanceLabels {
  const typeLabel: string = runtimeTypeLabel(runtimeType);
  const trimmed: string = name === null ? '' : name.trim();
  const instanceName: string | null =
    (trimmed.length > 0 && trimmed.toLowerCase() !== runtimeType.toLowerCase()) ? trimmed : null;
  const primary: string = instanceName ?? typeLabel;
  const secondary: string | null =
    typeLabel.toLowerCase() === primary.toLowerCase() ? null : typeLabel;
  return { primary: primary, secondary: secondary };
}

/**
 * The name a runtime instance is shown under, iOS's `sessionDisplayName`.
 *
 * iOS: `name.isEmpty ? displayName : name`. `runtimeInstanceLabels` above is
 * stricter — it throws away a name that merely repeats the runtime type — and
 * that also swallows a name which is the type's *abbreviation*: this device's
 * instance is named `DSH` and its runtime type is `dsh`, equal once lowercased,
 * so the row read "DeepSeek Harness" where iOS reads "DSH". The last fallback to
 * the type label is this port's own, so a title is never empty.
 */
export function runtimeInstanceName(
  name: string | null | undefined,
  displayName: string,
  runtimeType: string,
): string {
  const instance: string = name === null || name === undefined ? '' : name.trim();
  if (instance.length > 0) {
    return instance;
  }
  const sent: string = displayName.trim();
  return sent.length > 0 ? sent : runtimeTypeLabel(runtimeType);
}

/** The runtime type's display name, as the Server sends it, or the built-in one. */
export function runtimeTypeDisplayName(
  typeDisplayName: string | null | undefined,
  runtimeType: string,
): string {
  const sent: string = typeDisplayName === null || typeDisplayName === undefined
    ? '' : typeDisplayName.trim();
  return sent.length > 0 ? sent : runtimeTypeLabel(runtimeType);
}

/** Joins the non-empty labels the way a session row's context line does. */
export function runtimeContextLabel(name: string | null, runtimeType: string): string {
  const labels: RuntimeInstanceLabels = runtimeInstanceLabels(name, runtimeType);
  const parts: string[] = [labels.primary];
  if (labels.secondary !== null && labels.secondary.length > 0) {
    parts.push(labels.secondary);
  }
  return parts.join(' · ');
}
