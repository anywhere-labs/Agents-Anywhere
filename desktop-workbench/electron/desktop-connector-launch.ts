type ConnectorLaunchState = {
  hasCredential: boolean;
  manualDisconnected: boolean;
};

type DesktopConnectorLaunchOptions = {
  updateForced: boolean;
  enabled: boolean;
  getState: () => Promise<ConnectorLaunchState>;
  start: () => Promise<unknown>;
  onStartError: (error: unknown) => void;
};

export async function startDesktopConnectorOnLaunch(
  options: DesktopConnectorLaunchOptions,
): Promise<boolean> {
  if (options.updateForced || !options.enabled) return false;
  const state = await options.getState();
  if (!state.hasCredential || state.manualDisconnected) return false;
  void options.start().catch(options.onStartError);
  return true;
}
