/* eslint-disable */
/** Generated from contracts/runtime-control/2.1 artifact runtime-discover-response. Do not edit; run `yarn contracts:generate`. */

/**
 * Provider-owned discovery facts. runtimeType is a stable provider identifier, never an instance identifier or implementation category.
 */
export type RuntimeTypeDescriptor = {
  [k: string]: unknown
} & {
  available: boolean
  capabilities: {
    [k: string]: boolean
  }
  configSchema: RuntimeConfigSchema | null
  description: string | null
  displayName: string
  /**
   * Optional implementation category, separate from the stable provider identity.
   */
  implementationType: string | null
  instancePolicy: "single" | "multiple"
  /**
   * How mature the runtime or capability is. It is declared by the adapter and shown next to, never instead of, the lifecycle status.
   */
  maturity?: "experimental" | "beta" | "stable"
  maxInstances: number | null
  metadata: {
    [k: string]: unknown
  }
  modelConnection?: ModelConnectionCapability | null
  reason: string | null
  recommendationRank: number | null
  recommended: boolean
  runtimeType: string
}

/**
 * Provider descriptors and Connector-wide protocol features for the single supported Runtime Control protocol.
 */
export interface RuntimeDiscoverResponse {
  /**
   * Connector-wide protocol features. switchFence: runtime.validateConfig and runtime.start accept operationId and switchRevision, runtime.start reports configDigest and instanceId, and a fenced runtime.start always replaces the instance. modelProbe: runtime.probeModelConnection sends one minimal model request with the running instance's connection. Unknown entries must be ignored; absent means none. channelReconcileFence: extends persistent switch fencing to runtime.stop and managed-instance reconciliation; required for automatic channel catch-up.
   *
   * @maxItems 64
   */
  features?: string[]
  /**
   * @maxItems 64
   */
  runtimeTypes: RuntimeTypeDescriptor[]
}
/**
 * Provider-owned configuration contract for this runtime type.
 */
export interface RuntimeConfigSchema {
  defaults: {
    [k: string]: unknown
  }
  metadata: {
    [k: string]: unknown
  }
  revision: number
  /**
   * A JSON Schema whose root validates a runtime configuration object.
   */
  schema: {
    type: "object"
    [k: string]: unknown
  }
  uiSchema: {
    [k: string]: unknown
  } | null
}
/**
 * How the runtime takes a model connection from the unified configuration. Absent or null means the runtime does not support one.
 */
export interface ModelConnectionCapability {
  /**
   * When a saved connection takes effect.
   */
  apply: "immediate" | "new_session" | "restart"
  catalog: {
    auto: boolean
    manual: boolean
    /**
     * The connection is only used with models listed in `modelsField`; absent means false.
     */
    required?: boolean
  }
  /**
   * Top-level configuration field holding {baseUrl, apiKey}.
   */
  configField: string
  /**
   * How mature the runtime or capability is. It is declared by the adapter and shown next to, never instead of, the lifecycle status.
   */
  maturity: "experimental" | "beta" | "stable"
  /**
   * Configuration field that selects one of `modes`, when the runtime has modes.
   */
  modeField?: string | null
  modelsField: string | null
  /**
   * @maxItems 16
   */
  modes?:
    | []
    | [
        {
          id: string
          reason?: string | null
          supported: boolean
        },
      ]
    | [
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
      ]
    | [
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
      ]
    | [
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
      ]
    | [
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
      ]
    | [
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
      ]
    | [
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
      ]
    | [
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
      ]
    | [
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
      ]
    | [
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
      ]
    | [
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
      ]
    | [
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
      ]
    | [
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
      ]
    | [
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
      ]
    | [
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
      ]
    | [
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
        {
          id: string
          reason?: string | null
          supported: boolean
        },
      ]
  /**
   * @minItems 1
   * @maxItems 8
   */
  protocols:
    | ["openai_responses" | "openai_chat" | "anthropic"]
    | ["openai_responses" | "openai_chat" | "anthropic", "openai_responses" | "openai_chat" | "anthropic"]
    | [
        "openai_responses" | "openai_chat" | "anthropic",
        "openai_responses" | "openai_chat" | "anthropic",
        "openai_responses" | "openai_chat" | "anthropic",
      ]
    | [
        "openai_responses" | "openai_chat" | "anthropic",
        "openai_responses" | "openai_chat" | "anthropic",
        "openai_responses" | "openai_chat" | "anthropic",
        "openai_responses" | "openai_chat" | "anthropic",
      ]
    | [
        "openai_responses" | "openai_chat" | "anthropic",
        "openai_responses" | "openai_chat" | "anthropic",
        "openai_responses" | "openai_chat" | "anthropic",
        "openai_responses" | "openai_chat" | "anthropic",
        "openai_responses" | "openai_chat" | "anthropic",
      ]
    | [
        "openai_responses" | "openai_chat" | "anthropic",
        "openai_responses" | "openai_chat" | "anthropic",
        "openai_responses" | "openai_chat" | "anthropic",
        "openai_responses" | "openai_chat" | "anthropic",
        "openai_responses" | "openai_chat" | "anthropic",
        "openai_responses" | "openai_chat" | "anthropic",
      ]
    | [
        "openai_responses" | "openai_chat" | "anthropic",
        "openai_responses" | "openai_chat" | "anthropic",
        "openai_responses" | "openai_chat" | "anthropic",
        "openai_responses" | "openai_chat" | "anthropic",
        "openai_responses" | "openai_chat" | "anthropic",
        "openai_responses" | "openai_chat" | "anthropic",
        "openai_responses" | "openai_chat" | "anthropic",
      ]
    | [
        "openai_responses" | "openai_chat" | "anthropic",
        "openai_responses" | "openai_chat" | "anthropic",
        "openai_responses" | "openai_chat" | "anthropic",
        "openai_responses" | "openai_chat" | "anthropic",
        "openai_responses" | "openai_chat" | "anthropic",
        "openai_responses" | "openai_chat" | "anthropic",
        "openai_responses" | "openai_chat" | "anthropic",
        "openai_responses" | "openai_chat" | "anthropic",
      ]
  /**
   * What a saved connection changes: an AA-managed instance, one session, or the runtime's native global configuration.
   */
  scope: "instance" | "session" | "native_global"
  /**
   * Top-level configuration field holding the model new sessions use, {modelId, effortId?}. With a connection, modelId must be one of the models in `modelsField`. A change applies without restarting the runtime and never changes existing sessions; absent means the runtime takes no model setting.
   */
  modelField?: string
}
