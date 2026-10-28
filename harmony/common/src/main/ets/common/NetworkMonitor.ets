import { connection } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const LOG_TAG: string = 'AgentsAnywhere.Network';

export interface NetworkAvailabilityListener {
  onNetworkAvailable: () => void;
}

/**
 * Wraps @ohos.net.connection so a page can reconnect its realtime sockets the
 * moment the device regains connectivity, instead of waiting out the current
 * exponential-backoff delay.
 *
 * Requires the ohos.permission.GET_NETWORK_INFO permission (declared in
 * module.json5). Pages own one monitor each and must call stop() in
 * aboutToDisappear, otherwise the NetConnection callback leaks.
 */
export class NetworkMonitor {
  private netConnection: connection.NetConnection | null = null;

  start(listener: NetworkAvailabilityListener): void {
    this.stop();
    const netConnection = connection.createNetConnection();
    netConnection.on('netAvailable', () => {
      listener.onNetworkAvailable();
    });
    netConnection.register((error: BusinessError) => {
      if (error) {
        hilog.error(0x0000, LOG_TAG, 'netConnection register failed: %{public}s', error.message);
      }
    });
    this.netConnection = netConnection;
  }

  stop(): void {
    const netConnection = this.netConnection;
    if (netConnection !== null) {
      netConnection.unregister((error: BusinessError) => {
        if (error) {
          hilog.error(0x0000, LOG_TAG, 'netConnection unregister failed: %{public}s', error.message);
        }
      });
      this.netConnection = null;
    }
  }
}
