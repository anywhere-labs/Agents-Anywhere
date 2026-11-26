/**
 * Model gateways: which agents can be pointed at one, and what each of them reads to use it. A gateway is an address, a
 * key and maybe a model, kept per agent on the device (`agents.json`). It only reaches the processes Agents Anywhere
 * starts: the agents' own configuration is left alone, and so are the agents in the user's terminal.
 *
 * Every agent here was run against a gateway of its own and answered through it.
 */

import type { AcpSetProviderParams } from "./acp-protocol.js";
import type { ModelGateway } from "./config.js";

/** What a gateway must speak: Anthropic Messages, OpenAI Chat Completions or OpenAI Responses. */
export type GatewayApi = "anthropic" | "openai-chat" | "openai-responses";

/** How a process is started to use a gateway. */
export interface GatewayLaunch {
  env?: Record<string, string>;
  /** `_meta` of the sessions opened in it. */
  sessionMeta?: Record<string, unknown>;
  /** ACP `providers/set`, before its first session. */
  provider?: AcpSetProviderParams;
  /** What it was pointed at cannot be used (a CC Switch provider that is gone): no process is started, and this says why. */
  error?: string;
}

export interface AgentGateway {
  api: GatewayApi;
  /** It must be told which model to use: it has none to fall back on. */
  modelRequired: boolean;
  launch(gateway: ModelGateway): GatewayLaunch;
}

/** The address as an OpenAI client wants it: with the version (`/v1` when there is no path). */
function openAiUrl(baseUrl: string): string {
  return new URL(baseUrl).pathname === "/" ? `${withoutSlash(baseUrl)}/v1` : withoutSlash(baseUrl);
}

/** The address as Claude Code wants it: it adds `/v1` itself. */
function anthropicUrl(baseUrl: string): string {
  return withoutSlash(baseUrl).replace(/\/v1$/u, "");
}

function withoutSlash(url: string): string {
  return url.replace(/\/+$/u, "");
}

/**
 * Claude Code reads the environment, but `env` and `apiKeyHelper` in the user's own settings go before it; the settings
 * its adapter takes with a session go before those. Not `providers/set`: the adapter sends a key of its own then.
 */
export const CLAUDE_GATEWAY: AgentGateway = {
  api: "anthropic",
  modelRequired: false,
  launch: ({ base_url, api_key, model }) =>
    claudeLaunch({
      ANTHROPIC_BASE_URL: anthropicUrl(base_url),
      ANTHROPIC_AUTH_TOKEN: api_key,
      ...(model !== undefined
        ? {
            ANTHROPIC_MODEL: model,
            ANTHROPIC_DEFAULT_OPUS_MODEL: model,
            ANTHROPIC_DEFAULT_SONNET_MODEL: model,
            ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
            ANTHROPIC_DEFAULT_FABLE_MODEL: model,
            CLAUDE_CODE_SUBAGENT_MODEL: model,
          }
        : {}),
    }),
};

/**
 * Claude Code with these variables (an address and a key at least), in the environment and in the settings of its
 * sessions, so that neither the user's own settings nor other ways to sign in go before them.
 */
export function claudeLaunch(vars: Record<string, string>): GatewayLaunch {
  const env: Record<string, string> = {
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_CUSTOM_HEADERS: "",
    CLAUDE_CODE_USE_BEDROCK: "",
    CLAUDE_CODE_USE_VERTEX: "",
    ...vars,
  };
  return { env, sessionMeta: { claudeCode: { options: { settings: { apiKeyHelper: "", env: { ...env } } } } } };
}

export const CODEX_GATEWAY: AgentGateway = {
  api: "openai-responses",
  modelRequired: false,
  launch: ({ base_url, api_key, model }) => codexLaunch(openAiUrl(base_url), api_key, model),
};

/** Codex answering through this address (as Codex takes it: the Responses API is under it) with this key. */
export function codexLaunch(baseUrl: string, apiKey: string, model?: string): GatewayLaunch {
  return {
    provider: { providerId: "openai", apiType: "openai", baseUrl: withoutSlash(baseUrl), headers: { Authorization: `Bearer ${apiKey}` } },
    ...(model !== undefined ? { env: { CODEX_CONFIG: JSON.stringify({ model }) } } : {}),
  };
}

export const COPILOT_GATEWAY: AgentGateway = {
  api: "openai-chat",
  modelRequired: true,
  launch: ({ base_url, api_key, model }) => ({
    env: {
      COPILOT_PROVIDER_TYPE: "openai",
      COPILOT_PROVIDER_BASE_URL: openAiUrl(base_url),
      COPILOT_PROVIDER_API_KEY: api_key,
      COPILOT_MODEL: model ?? "",
    },
  }),
};

export const GOOSE_GATEWAY: AgentGateway = {
  api: "openai-chat",
  modelRequired: true,
  launch: ({ base_url, api_key, model }) => {
    const url = new URL(openAiUrl(base_url));
    return {
      env: {
        GOOSE_PROVIDER: "openai",
        GOOSE_MODEL: model ?? "",
        OPENAI_HOST: url.origin,
        OPENAI_BASE_PATH: `${withoutSlash(url.pathname).slice(1)}/chat/completions`,
        OPENAI_API_KEY: api_key,
      },
    };
  },
};

export const KIMI_GATEWAY: AgentGateway = {
  api: "openai-chat",
  modelRequired: true,
  launch: ({ base_url, api_key, model }) => ({
    env: {
      KIMI_MODEL_PROVIDER_TYPE: "openai",
      KIMI_MODEL_BASE_URL: openAiUrl(base_url),
      KIMI_MODEL_API_KEY: api_key,
      KIMI_MODEL_NAME: model ?? "",
    },
  }),
};

export const QWEN_GATEWAY: AgentGateway = {
  api: "openai-chat",
  modelRequired: true,
  launch: ({ base_url, api_key, model }) => ({
    env: { OPENAI_BASE_URL: openAiUrl(base_url), OPENAI_API_KEY: api_key, OPENAI_MODEL: model ?? "" },
  }),
};

/** OpenCode and Kilo Code take a piece of their configuration from a variable: a provider of its own. */
function configGateway(variable: string): AgentGateway {
  return {
    api: "openai-chat",
    modelRequired: true,
    launch: ({ base_url, api_key, model = "" }) => ({
      env: {
        [variable]: JSON.stringify({
          model: `gateway/${model}`,
          provider: {
            gateway: {
              npm: "@ai-sdk/openai-compatible",
              name: "Model gateway",
              options: { baseURL: openAiUrl(base_url), apiKey: api_key },
              models: { [model]: { name: model } },
            },
          },
        }),
      },
    }),
  };
}

export const OPENCODE_GATEWAY = configGateway("OPENCODE_CONFIG_CONTENT");
export const KILO_GATEWAY = configGateway("KILO_CONFIG_CONTENT");
