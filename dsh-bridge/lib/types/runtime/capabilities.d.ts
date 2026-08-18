import type { RuntimeStatus } from '../wire/protocol.js';
import type { Capability } from '../wire/protocol.js';
/** Capabilities implemented by the process regardless of Session state. */
export declare function runtimeCapabilities(): Capability[];
/** Effective Session capabilities for one projected state. */
export declare function sessionCapabilities(sessionId: string, status: RuntimeStatus, modelAvailable: boolean): Capability[];
