const RUNTIME_CAPABILITIES = [
    'runtime.config',
    'catalog.model',
    'catalog.permission',
    'catalog.effort',
];
const SESSION_CAPABILITIES = [
    'session.send_message',
    'session.interrupt',
    'session.steer',
    'session.interaction.approval',
    'session.commands',
];
/** Capabilities implemented by the process regardless of Session state. */
export function runtimeCapabilities() {
    return RUNTIME_CAPABILITIES.map(capabilityId => ({
        capabilityId,
        scope: 'runtime',
        supported: true,
        available: true,
        allowed: true,
    }));
}
/** Effective Session capabilities for one projected state. */
export function sessionCapabilities(sessionId, status, modelAvailable) {
    return SESSION_CAPABILITIES.map((capabilityId) => {
        let available = status !== 'error';
        if (capabilityId === 'session.send_message')
            available = status === 'idle' && modelAvailable;
        if (capabilityId === 'session.steer')
            available = status === 'running';
        if (capabilityId === 'session.interrupt')
            available = ['running', 'waiting_approval', 'blocked', 'stopping'].includes(status);
        if (capabilityId === 'session.commands')
            available = status === 'idle';
        if (capabilityId === 'session.interaction.approval') {
            available = status === 'waiting_approval' || status === 'blocked' || status === 'running' || status === 'idle';
        }
        return {
            capabilityId,
            scope: 'session',
            sessionId,
            supported: true,
            available,
            allowed: true,
            ...(available ? {} : { unavailableReason: unavailableReason(status, modelAvailable) }),
        };
    });
}
function unavailableReason(status, modelAvailable) {
    if (!modelAvailable)
        return 'Select a model that is available in the current DSH catalog.';
    return `The operation is unavailable while the Session status is ${status}.`;
}
//# sourceMappingURL=capabilities.js.map