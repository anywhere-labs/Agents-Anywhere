import type { Context } from '@deepseek-ai/cordis';
import type { ModelSelection } from '@deepseek-ai/dsh-agent';
import type { MetadataStore } from '../persistence/metadata.js';
import type { ModelCatalogItem, PermissionCatalogItem } from '../wire/protocol.js';
/** Immutable model and permission catalogs plus their durable revision. */
export interface CatalogSnapshot {
    revision: number;
    models: ModelCatalogItem[];
    permissions: PermissionCatalogItem[];
}
/** Builds, validates, and fingerprints catalogs from mounted DSH services. */
export declare class CatalogManager {
    private readonly ctx;
    private readonly metadata;
    private snapshot;
    private refreshPromise;
    /**
     * @param ctx - Bridge context with llm/default-model/permission services.
     * @param metadata - Durable catalog revision owner.
     */
    constructor(ctx: Context, metadata: MetadataStore);
    /** Return the current snapshot, refreshing it once when absent. */
    current(): Promise<CatalogSnapshot>;
    /** Rebuild both catalogs and advance the revision only on semantic change. */
    refresh(): Promise<CatalogSnapshot>;
    /** Resolve a model selection ID against the current enabled catalog. */
    resolveModel(id: string): Promise<ModelSelection>;
    /** Resolve and validate the configured default model. */
    defaultModel(): Promise<ModelSelection>;
    /** Resolve a permission selection ID against switchable presets. */
    resolvePermission(id: string): Promise<string>;
    /** Encode the effective permission of an existing Session log. */
    permissionFor(events: Parameters<Context['permissionPresets']['current']>[0]): string;
    private build;
}
