/** Durable AA-to-DSH session binding. */
export interface BindingRecord {
    version: 1;
    platformSessionId: string;
    externalSessionId: string;
}
/** Durable client-message idempotency record. */
export interface MessageRecord {
    version: 1;
    platformSessionId: string;
    clientMessageId: string;
    operation: 'create' | 'start' | 'steer';
    contentHash: string;
    messageId: string;
}
/** Durable candidate Session reservation for create-and-start recovery. */
export interface CreationRecord {
    version: 1;
    platformSessionId: string;
    clientMessageId: string;
    externalSessionId: string;
    committed: boolean;
}
/** Owns bridge-only durable metadata below the configured state root. */
export declare class MetadataStore {
    readonly root: string;
    private readonly bindingsByPlatform;
    private readonly bindingsByExternal;
    private bindingTail;
    private catalogTail;
    /** @param root - Validated absolute bridge state directory. */
    constructor(root: string);
    /** Load and cross-check all durable bindings before wire startup. */
    initialize(): Promise<void>;
    /** Resolve an existing binding by platform Session ID. */
    bindingForPlatform(platformSessionId: string): BindingRecord | undefined;
    /** Resolve an existing binding by DSH Session ID. */
    bindingForExternal(externalSessionId: string): BindingRecord | undefined;
    /** Create a binding once, rejecting either-direction conflicts. */
    bind(platformSessionId: string, externalSessionId: string): Promise<BindingRecord>;
    private bindCore;
    /** Reserve or recover one candidate DSH Session ID for create-and-start. */
    reserveCreation(platformSessionId: string, clientMessageId: string): Promise<CreationRecord>;
    /** Mark a recovered creation reservation committed after Session durability. */
    commitCreation(record: CreationRecord): Promise<void>;
    /** Read an idempotency record for one AA Session and client message. */
    message(platformSessionId: string, clientMessageId: string): Promise<MessageRecord | undefined>;
    /** Publish a message record without replacing an earlier operation. */
    recordMessage(input: Omit<MessageRecord, 'version' | 'messageId'>): Promise<{
        record: MessageRecord;
        duplicate: boolean;
    }>;
    /** Return a monotonic durable revision for one canonical catalog fingerprint. */
    catalogRevision(fingerprint: string): Promise<number>;
    private path;
}
