import { createHash } from 'node:crypto';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { BridgeError } from '../wire/errors.js';
/** SHA-256 hex digest of UTF-8 text. */
export function sha256Hex(value) {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}
/** Stable AA timeline item identity. */
export function timelineItemId(externalSessionId, projectionKind, businessId) {
    return `dsh_${sha256Hex(`${externalSessionId}\0${projectionKind}\0${businessId}`)}`;
}
/** Deterministic DSH MessageId text for one AA client operation. */
export function deterministicMessageId(platformSessionId, clientMessageId) {
    return `aa-${sha256Hex(`${platformSessionId}\0${clientMessageId}`)}`;
}
/** Serialize JSON using sorted object keys and no insignificant whitespace. */
export function canonicalJson(value) {
    return JSON.stringify(canonicalValue(value));
}
/** Hash one canonical timeline payload. */
export function contentHash(value) {
    return sha256Hex(canonicalJson(value));
}
function canonicalValue(value) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean')
        return value;
    if (typeof value === 'number') {
        if (!Number.isFinite(value))
            throw new TypeError('canonical JSON rejects non-finite numbers');
        return value;
    }
    if (Array.isArray(value))
        return value.map(canonicalValue);
    if (typeof value !== 'object')
        throw new TypeError(`canonical JSON rejects ${typeof value}`);
    const output = {};
    for (const key of Object.keys(value).sort()) {
        const item = value[key];
        if (item !== undefined)
            output[key] = canonicalValue(item);
    }
    return output;
}
function encodeJson(value) {
    return Buffer.from(canonicalJson(value), 'utf8').toString('base64url');
}
/** Encode a model selection as an opaque bridge v1 selection ID. */
export function modelSelectionId(selection) {
    return `dsh:model:${encodeJson([selection.provider, selection.model, selection.reasoningEffort ?? null])}`;
}
/** Encode a permission preset as an opaque bridge v1 selection ID. */
export function permissionSelectionId(preset) {
    return `dsh:permission:${Buffer.from(preset, 'utf8').toString('base64url')}`;
}
/** Decode and structurally validate a bridge v1 model selection ID. */
export function decodeModelSelectionId(id) {
    if (!id.startsWith('dsh:model:'))
        throw invalidSelection();
    try {
        const encoded = id.slice('dsh:model:'.length);
        const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
        const parsed = JSON.parse(decoded);
        if (encodeJson(parsed) !== encoded || !Array.isArray(parsed) || parsed.length !== 3)
            throw invalidSelection();
        const [provider, model, effort] = parsed;
        if (typeof provider !== 'string' || provider.length === 0 || typeof model !== 'string' || model.length === 0) {
            throw invalidSelection();
        }
        if (effort !== null && (typeof effort !== 'string' || effort.length === 0))
            throw invalidSelection();
        return {
            provider,
            model,
            ...(effort === null ? {} : { reasoningEffort: ReasoningEffortId(effort) }),
        };
    }
    catch (error) {
        if (error instanceof BridgeError)
            throw error;
        throw invalidSelection();
    }
}
/** Decode and structurally validate a bridge v1 permission selection ID. */
export function decodePermissionSelectionId(id) {
    if (!id.startsWith('dsh:permission:'))
        throw invalidSelection();
    try {
        const preset = Buffer.from(id.slice('dsh:permission:'.length), 'base64url').toString('utf8');
        if (preset.length === 0 || permissionSelectionId(preset) !== id)
            throw invalidSelection();
        return preset;
    }
    catch (error) {
        if (error instanceof BridgeError)
            throw error;
        throw invalidSelection();
    }
}
function invalidSelection() {
    return new BridgeError('INVALID_SELECTION', 'The selection ID is invalid or has the wrong kind.', { retryable: false });
}
//# sourceMappingURL=identity.js.map