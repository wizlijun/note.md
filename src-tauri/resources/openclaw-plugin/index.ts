// index.ts
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { notemdPlugin, ensureServer, stopServer, startChannel } from "./src/channel.js";
import { setNotemdRuntime } from "./src/runtime.js";
import { NotemdConfigSchema } from "./src/config-schema.js";

const plugin = {
  id: "notemd",
  name: "note.md Chat",
  description: "Local note.md desktop chat via UDS.",
  configSchema: { type: "object" as const, additionalProperties: false, properties: {} },
  // OpenClaw requires `register` to be synchronous (must not return a Promise).
  // The UDS server startup is async, so we fire-and-forget it inside the sync
  // body; any error there is logged but does not block plugin registration.
  register(api: OpenClawPluginApi): void {
    setNotemdRuntime(api);
    api.registerChannel({ plugin: notemdPlugin });
    const raw = api.config?.read?.("channels.notemd.accounts.default") ?? {};
    const cfg = NotemdConfigSchema.parse(raw);
    void (async () => {
      try {
        await ensureServer(cfg);
        await startChannel();
      } catch (e) {
        console.error("[notemd] startup failed:", e);
      }
    })();
  },
  async unregister(): Promise<void> {
    await stopServer();
  },
};

export default plugin;
