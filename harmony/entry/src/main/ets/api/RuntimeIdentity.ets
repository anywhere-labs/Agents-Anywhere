/**
 * Runtime identifier validation.
 *
 * Port of `api/RuntimeIdentity.kt`.
 *
 * The create request carries both a runtime *type* (`codex`, `claude`, `dsh`) and
 * a runtime *instance* id (`rti_…`). Older deployments only know the type, so an
 * instance id that still equals the type is accepted — which is why the two
 * checks differ and why the instance check takes the type as an argument.
 */

const RUNTIME_TYPE_PATTERN: RegExp = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const RUNTIME_INSTANCE_PATTERN: RegExp = /^rti_[A-Za-z0-9_-]{1,124}$/;

/** A runtime type: 1..64 characters, never an `rti_` instance id. */
export function isValidRuntimeType(value: string): boolean {
  if (value.length < 1 || value.length > 64) {
    return false;
  }
  if (value.startsWith('rti_')) {
    return false;
  }
  return RUNTIME_TYPE_PATTERN.test(value);
}

/** A runtime instance id, or the runtime type itself. */
export function isValidRuntimeInstanceId(value: string, runtimeType: string): boolean {
  if (value === runtimeType) {
    return true;
  }
  return value.length <= 128 && RUNTIME_INSTANCE_PATTERN.test(value);
}
