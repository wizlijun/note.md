// index.ts
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { mdeditorPlugin, ensureServer, stopServer, startChannel } from "./src/channel.js";
import { setMdeditorRuntime } from "./src/runtime.js";
import { MdeditorConfigSchema } from "./src/config-schema.js";

const plugin = {
  id: "mdeditor",
  name: "M↓ Chat",
  description: "Local M↓ desktop chat via UDS.",
  configSchema: { type: "object" as const, additionalProperties: false, properties: {} },
  // OpenClaw requires `register` to be synchronous (must not return a Promise).
  // The UDS server startup is async, so we fire-and-forget it inside the sync
  // body; any error there is logged but does not block plugin registration.
  register(api: OpenClawPluginApi): void {
    setMdeditorRuntime(api);
    api.registerChannel({ plugin: mdeditorPlugin });
    const raw = api.config?.read?.("channels.mdeditor.accounts.default") ?? {};
    const cfg = MdeditorConfigSchema.parse(raw);
    void (async () => {
      try {
        await ensureServer(cfg);
        await startChannel();
      } catch (e) {
        console.error("[mdeditor] startup failed:", e);
      }
    })();
  },
  async unregister(): Promise<void> {
    await stopServer();
  },
};

export default plugin;
