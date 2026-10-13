import { TerminalController } from './TerminalController';
import { RemoteTerminalController } from './RemoteTerminalController';

/**
 * One terminal per device (or session), kept alive across navigations.
 *
 * Port of `feature/terminal/RemoteTerminalPool.kt`.
 *
 * A pool entry outlives the screen that showed it: leaving the terminal and
 * coming back reuses the same controller, so the remote shell is still running
 * and the screen is restored from the controller's snapshot rather than
 * re-created.
 */
export class RemoteTerminalPool {
  private readonly terminalController: TerminalController;
  private readonly controllers: Map<string, RemoteTerminalController> = new Map();

  constructor(terminalController: TerminalController) {
    this.terminalController = terminalController;
  }

  forSession(sessionId: string | null): RemoteTerminalController {
    return this.controllerFor(`session:${sessionId === null ? '' : sessionId}`);
  }

  forDevice(deviceId: string | null): RemoteTerminalController {
    return this.controllerFor(`device:${deviceId === null ? '' : deviceId}`);
  }

  /** Retires every controller; called when the account goes away. */
  disposeLocal(): void {
    this.controllers.forEach((controller: RemoteTerminalController) => {
      controller.disposeLocal();
    });
    this.controllers.clear();
  }

  private controllerFor(key: string): RemoteTerminalController {
    const existing: RemoteTerminalController | undefined = this.controllers.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const created: RemoteTerminalController = new RemoteTerminalController(this.terminalController);
    this.controllers.set(key, created);
    return created;
  }
}
