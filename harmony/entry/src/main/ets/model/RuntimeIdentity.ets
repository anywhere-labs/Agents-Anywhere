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

/** Joins the non-empty labels the way a session row's context line does. */
export function runtimeContextLabel(name: string | null, runtimeType: string): string {
  const labels: RuntimeInstanceLabels = runtimeInstanceLabels(name, runtimeType);
  const parts: string[] = [labels.primary];
  if (labels.secondary !== null && labels.secondary.length > 0) {
    parts.push(labels.secondary);
  }
  return parts.join(' · ');
}
