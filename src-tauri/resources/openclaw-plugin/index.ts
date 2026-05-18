// index.ts
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { mdeditorPlugin, ensureServer, stopServer, startChannel } from "./src/channel.js";
import { MdeditorConfigSchema } from "./src/config-schema.js";
import { setMdeditorRuntime } from "./src/runtime.js";

const plugin = {
  id: "mdeditor",
  name: "M↓ Chat",
  description: "Local M↓ desktop chat via UDS.",
  configSchema: { type: "object" as const, additionalProperties: false, properties: {} },
  async register(api: OpenClawPluginApi): Promise<void> {
    setMdeditorRuntime(api);
    api.registerChannel({ plugin: mdeditorPlugin });
    // api.config is the full OpenClawConfig object (not a reader function).
    // Plugin-specific config lives in api.pluginConfig (Record<string, unknown> | undefined).
    // Fall back to empty object for Zod defaults (socketPath, maxClients) when not configured.
    const raw = api.pluginConfig ?? {};
    const cfg = MdeditorConfigSchema.parse(raw);
    await ensureServer(cfg);
    await startChannel();
  },
  async unregister(): Promise<void> {
    await stopServer();
  },
};

export default plugin;
