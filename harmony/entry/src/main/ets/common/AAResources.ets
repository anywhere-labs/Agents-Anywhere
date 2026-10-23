import { resourceManager } from '@kit.LocalizationKit';
import { AALog } from './AAAppLog';

/**
 * Resource strings as plain `string`.
 *
 * A `$r(...)` call hands ArkUI a `Resource` descriptor — it is not a string, and
 * calling `.toString()` on it yields the literal text "[object Object]". That is
 * what the settings drawer's trailing labels, its appearance/language/sidebar
 * menus and a number of error paths were showing, because the port used
 * `.toString()` wherever a real `string` was needed.
 *
 * Anything that must be a `string` — component state, an error message, the
 * `systemShare` title, an `accessibilityText` fallback — goes through here
 * instead, which keeps ArkUI's own resource path for everything that can stay a
 * `Resource`.
 *
 * `getStringSync` needs a resource manager, and a plain function has no
 * `getUIContext()`, so `EntryAbility` hands its manager in once at start-up.
 * The deprecated global `getContext()` is deliberately not used.
 */
let installedManager: resourceManager.ResourceManager | null = null;

/** Called by `EntryAbility.onCreate`, before any screen is built. */
export function installResourceManager(manager: resourceManager.ResourceManager): void {
  installedManager = manager;
}

/** A `Resource` as localized text; `''` when it cannot be resolved. */
export function resolveString(resource: Resource): string {
  const manager: resourceManager.ResourceManager | null = installedManager;
  if (manager === null) {
    AALog.warn('A string was requested before the resource manager was installed');
    return '';
  }
  try {
    return manager.getStringSync(resource.id);
  } catch (error) {
    const message: string = error instanceof Error ? error.message : 'unknown';
    AALog.warn(`String ${resource.id} could not be resolved: ${message}`);
    return '';
  }
}

/**
 * The same, for a resource with `%s`/`%d` placeholders.
 *
 * `getStringSync` takes the substitutions variadically, and this port uses no
 * spread calls, so the arities actually needed are spelled out.
 */
export function resolveStringWith(resource: Resource, args: Array<string | number>): string {
  const manager: resourceManager.ResourceManager | null = installedManager;
  if (manager === null) {
    AALog.warn('A string was requested before the resource manager was installed');
    return '';
  }
  try {
    if (args.length === 1) {
      return manager.getStringSync(resource.id, args[0]);
    }
    if (args.length === 2) {
      return manager.getStringSync(resource.id, args[0], args[1]);
    }
    if (args.length === 3) {
      return manager.getStringSync(resource.id, args[0], args[1], args[2]);
    }
    return manager.getStringSync(resource.id);
  } catch (error) {
    const message: string = error instanceof Error ? error.message : 'unknown';
    AALog.warn(`String ${resource.id} could not be resolved: ${message}`);
    return '';
  }
}

/** A `ResourceStr` — an ordinary string, or a resource — as text. */
export function resolveText(value: ResourceStr): string {
  return typeof value === 'string' ? value : resolveString(value);
}
