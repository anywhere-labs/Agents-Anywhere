/**
 * Navigation destinations.
 *
 * Ported from android/app/src/main/java/com/agentsanywhere/app/navigation/AppDestination.kt.
 *
 * Android is a plain enum driving one `AnimatedContent`: navigation means
 * "set the current destination", there is no back stack, and each screen owns
 * its own back handling. The ordinal is load-bearing — the screen transition
 * direction is decided by `target > current` — so the declaration order here
 * must match the Kotlin enum exactly.
 */
export enum AppDestination {
  LoginMethods = 0,
  ServerSetup = 1,
  QrLogin = 2,
  QrWaiting = 3,
  Sessions = 4,
  NewSession = 5,
  NewProject = 6,
  Devices = 7,
  Terminal = 8,
  Files = 9,
  DeviceDetail = 10,
  SessionDetail = 11,
  ArchivedSessions = 12,
  DeviceSetup = 13,
}

const DESTINATION_TITLES: string[] = [
  'Login',
  'Server',
  'QR Login',
  'Waiting',
  'Sessions',
  'New Session',
  'New Project',
  'Devices',
  'Terminal',
  'Files',
  'Device Detail',
  'Session',
  'Archived Sessions',
  'Device Setup',
];

/** The Android `AppDestination.title` label, used for accessibility and logs. */
export function appDestinationTitle(destination: AppDestination): string {
  const index: number = destination as number;
  if (index < 0 || index >= DESTINATION_TITLES.length) {
    return 'Unknown';
  }
  return DESTINATION_TITLES[index];
}

/**
 * Destinations reachable while signed out. Android enforces this structurally:
 * the initial destination is chosen once from `hasAuthSession()`, and nothing
 * navigates to the signed-in screens, so there is no per-route guard to port.
 */
export function isSignedOutDestination(destination: AppDestination): boolean {
  return destination === AppDestination.LoginMethods
    || destination === AppDestination.ServerSetup
    || destination === AppDestination.QrLogin
    || destination === AppDestination.QrWaiting;
}

/**
 * True when a destination has somewhere to go back to.
 *
 * The two roots are the sign-in method picker and the sessions list: on either
 * one, a back gesture belongs to the platform, which is how Android behaves.
 */
export function canNavigateBackFrom(destination: AppDestination): boolean {
  return destination !== AppDestination.LoginMethods
    && destination !== AppDestination.Sessions;
}
