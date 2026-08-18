import type { ModelSelection } from '@deepseek-ai/dsh-agent';
/** SHA-256 hex digest of UTF-8 text. */
export declare function sha256Hex(value: string): string;
/** Stable AA timeline item identity. */
export declare function timelineItemId(externalSessionId: string, projectionKind: string, businessId: string): string;
/** Deterministic DSH MessageId text for one AA client operation. */
export declare function deterministicMessageId(platformSessionId: string, clientMessageId: string): string;
/** Serialize JSON using sorted object keys and no insignificant whitespace. */
export declare function canonicalJson(value: unknown): string;
/** Hash one canonical timeline payload. */
export declare function contentHash(value: unknown): string;
/** Encode a model selection as an opaque bridge v1 selection ID. */
export declare function modelSelectionId(selection: ModelSelection): string;
/** Encode a permission preset as an opaque bridge v1 selection ID. */
export declare function permissionSelectionId(preset: string): string;
/** Decode and structurally validate a bridge v1 model selection ID. */
export declare function decodeModelSelectionId(id: string): ModelSelection;
/** Decode and structurally validate a bridge v1 permission selection ID. */
export declare function decodePermissionSelectionId(id: string): string;
