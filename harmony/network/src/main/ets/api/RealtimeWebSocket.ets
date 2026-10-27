import { webSocket } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';

export interface RealtimeSocketListener {
  onOpen: () => void;

  onMessage: (text: string) => void;

  onClose: (code: number, reason: string) => void;

  onError: (message: string) => void;
}

export class RealtimeWebSocket {
  private socket: webSocket.WebSocket | null = null;

  connect(url: string, listener: RealtimeSocketListener, headers?: Record<string, string>): void {
    this.destroy();
    const socket = webSocket.createWebSocket();
    this.socket = socket;
    socket.on('open', (error: BusinessError, value: Object) => {
      listener.onOpen();
    });
    socket.on('message', (error: BusinessError, value: string | ArrayBuffer) => {
      if (typeof value === 'string') {
        listener.onMessage(value);
      }
    });
    socket.on('close', (error: BusinessError, value: webSocket.CloseResult) => {
      listener.onClose(value.code, value.reason);
    });
    socket.on('error', (error: BusinessError) => {
      listener.onError(error.message);
    });
    if (headers !== undefined) {
      const options: webSocket.WebSocketRequestOptions = { header: headers };
      socket.connect(url, options).catch((error: BusinessError) => {
        listener.onError(error.message);
      });
    } else {
      socket.connect(url).catch((error: BusinessError) => {
        listener.onError(error.message);
      });
    }
  }

  send(text: string): Promise<boolean> {
    const socket = this.socket;
    if (socket === null) {
      return Promise.resolve(false);
    }
    return socket.send(text);
  }

  close(): Promise<boolean> {
    const socket = this.socket;
    if (socket === null) {
      return Promise.resolve(false);
    }
    return socket.close();
  }

  destroy(): void {
    const socket = this.socket;
    if (socket !== null) {
      socket.off('open');
      socket.off('message');
      socket.off('close');
      socket.off('error');
      socket.close().catch(() => {
      });
      this.socket = null;
    }
  }
}
