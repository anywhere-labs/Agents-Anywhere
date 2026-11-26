// `@streamdown/mermaid` for the mobile render bundle (aliased in embed/vite.config.ts). Mermaid is ~2 MB, more than the
// rest of the bundle together; without the plugin Streamdown shows a diagram as its source, which is what the
// mobile bundle does. Same exports as the real module.
import type { PluginConfig } from "streamdown"

export const mermaid: PluginConfig["mermaid"] = undefined
export const createMermaidPlugin = (): PluginConfig["mermaid"] => undefined
