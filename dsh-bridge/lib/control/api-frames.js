import { randomUUID } from 'node:crypto';
/** Assign one push-only mux correlation id. */
export function bridgeMuxEnvelope(payload) {
    return { rpcId: randomUUID(), payload };
}
/** Assign one push-only Host correlation id. */
export function bridgeHostEnvelope(payload) {
    return { rpcId: randomUUID(), payload };
}
//# sourceMappingURL=api-frames.js.map