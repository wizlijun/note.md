// src/channel.ts
//
// Adapter notes (SDK delta vs. plan):
//   - ChannelConfigAdapter.resolveAccount(cfg: OpenClawConfig, accountId?) — first arg is full cfg
//   - ChannelConfigAdapter.listAccountIds(cfg: OpenClawConfig) — required field
//   - ChannelCapabilities uses chatTypes: Array<ChatType | "thread"> not boolean flags
//   - ChannelOutboundAdapter requires mandatory deliveryMode field
//   - ChannelStreamingAdapter has no deliverDelta — only optional blockStreamingCoalesceDefaults
//   - ChannelMessagingAdapter has no deliver method — it's purely a normalisation adapter
//
// Task 9 findings — real inbound dispatch (case c):
//   The OpenClaw SDK does NOT expose a deliverInbound()/gatewayInbound() push API.
//   Instead, inbound messages are dispatched through the reply pipeline via:
//     core.channel.routing.resolveAgentRoute(...)      → sessionKey / agentId
//     core.channel.reply.finalizeInboundContext(...)   → FinalizedMsgContext
//     core.channel.reply.createReplyDispatcherWithTyping({ deliver }) → dispatcher
//     core.channel.reply.withReplyDispatcher + dispatchReplyFromConfig
//   This is the same pattern used by the matrix channel (see
//   ~/git/openclaw/extensions/matrix/src/matrix/monitor/handler.ts:658).
//   Both `core` (api.runtime) and `cfg` (api.config) are accessible via getNotemdRuntime().
import type {
  ChannelPlugin,
  ChannelConfigAdapter,
  ChannelOutboundAdapter,
  ChannelStreamingAdapter,
  ChannelStatusAdapter,
  ChannelMessagingAdapter,
} from "openclaw/plugin-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { NotemdConfigSchema, type NotemdConfig } from "./config-schema.js";
import type { Frame } from "./protocol.js";
import {
  ensureServer,
  stopServer,
  sendToHost,
  getSessionPool,
  setHostFrameHandler,
  getNotemdRuntime,
} from "./runtime.js";

interface ResolvedAccount {
  accountId: string;
  config: NotemdConfig;
}

// ---------------------------------------------------------------------------
// ChannelConfigAdapter
// Reads notemd config from cfg.channels?.notemd?.accounts?.[accountId]
// (or top-level cfg.channels?.notemd for the default account).
// ---------------------------------------------------------------------------
const config: ChannelConfigAdapter<ResolvedAccount> = {
  listAccountIds: (_cfg: OpenClawConfig): string[] => ["default"],

  resolveAccount: (cfg: OpenClawConfig, accountId?: string | null): ResolvedAccount => {
    const id = accountId ?? "default";
    // Extension channels live under channels.<id>.accounts.<accountId> or channels.<id>.*
    const channels = (cfg as Record<string, unknown>).channels as
      | Record<string, unknown>
      | undefined;
    const channelSection = channels?.["notemd"] as Record<string, unknown> | undefined;
    const accountsSection = channelSection?.["accounts"] as Record<string, unknown> | undefined;
    const raw = (accountsSection?.[id] ?? channelSection ?? {}) as Record<string, unknown>;
    const parsed = NotemdConfigSchema.parse(raw);
    return { accountId: id, config: parsed };
  },

  defaultAccountId: (_cfg: OpenClawConfig): string => "default",

  isConfigured: (_account: ResolvedAccount, _cfg: OpenClawConfig): boolean => true,
};

// ---------------------------------------------------------------------------
// ChannelMessagingAdapter — purely normalisation; no deliver method in SDK.
// ---------------------------------------------------------------------------
const messaging: ChannelMessagingAdapter = {
  normalizeTarget: (raw: string): string | undefined => {
    const trimmed = raw.trim();
    return trimmed || undefined;
  },
};

// ---------------------------------------------------------------------------
// ChannelStreamingAdapter — SDK only has blockStreamingCoalesceDefaults.
// deliverDelta for UDS is handled by sendToHost calls from the gateway (Task 9).
// ---------------------------------------------------------------------------
const streaming: ChannelStreamingAdapter = {
  // No deliverDelta in this SDK version; streaming output to note.md host is done
  // via sendToHost() called from the gateway context in Task 9.
};

// ---------------------------------------------------------------------------
// ChannelOutboundAdapter — deliveryMode required; no real outbound for MVP.
// ---------------------------------------------------------------------------
const outbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
};

// ---------------------------------------------------------------------------
// ChannelStatusAdapter — minimal, no-op for MVP.
// ---------------------------------------------------------------------------
const status: ChannelStatusAdapter<ResolvedAccount> = {};

// ---------------------------------------------------------------------------
// ChannelPlugin export
// ---------------------------------------------------------------------------
export const notemdPlugin: ChannelPlugin<ResolvedAccount> = {
  id: "notemd",
  meta: {
    id: "notemd",
    label: "note.md Chat",
    selectionLabel: "note.md Chat (plugin)",
    docsPath: "/channels/notemd",
    docsLabel: "notemd",
    blurb: "Local note.md desktop chat via UDS.",
    order: 90,
    quickstartAllowFrom: false,
  },
  capabilities: {
    chatTypes: ["direct"],
  },
  config,
  messaging,
  streaming,
  outbound,
  status,
};

// ---------------------------------------------------------------------------
// Wire the host-frame handler: messages FROM note.md host arriving on UDS.
// ---------------------------------------------------------------------------
export async function startChannel(): Promise<void> {
  setHostFrameHandler((f) => onHostFrame(f));
}

function onHostFrame(f: Frame): void {
  switch (f.type) {
    case "user.message":
      {
        const sid = (f.session as string | undefined) ?? getOrCreateDefaultSession();
        const text = (f.text as string | undefined) ?? "";
        const msgId = "m-" + Date.now().toString(36);
        getSessionPool().append(sid, { id: msgId, role: "user", text });

        // Dispatch into the OpenClaw agent pipeline.
        // Pattern: core.channel.reply.createReplyDispatcherWithTyping + withReplyDispatcher
        //          + dispatchReplyFromConfig  (same as matrix channel handler.ts:658).
        // core  = api.runtime  (PluginRuntime  — ~/git/openclaw/src/plugins/runtime/types.ts)
        // cfg   = api.config   (OpenClawConfig — full config passed at plugin registration)
        void (async () => {
          try {
            const api = getNotemdRuntime();
            const core = api.runtime;
            const cfg = api.config;

            const route = core.channel.routing.resolveAgentRoute({
              cfg,
              channel: "notemd",
              accountId: "default",
              peer: { kind: "direct", id: sid },
            });

            const ctxPayload = core.channel.reply.finalizeInboundContext({
              Body: text,
              BodyForAgent: text,
              RawBody: text,
              CommandBody: text,
              From: `notemd:${sid}`,
              To: `session:${sid}`,
              SessionKey: route.sessionKey,
              AccountId: route.accountId,
              ChatType: "direct" as const,
              Provider: "notemd" as const,
              Surface: "notemd" as const,
              MessageSid: msgId,
            });

            const { dispatcher, replyOptions, markDispatchIdle } =
              core.channel.reply.createReplyDispatcherWithTyping({
                deliver: async (payload) => {
                  const replyText = payload.text ?? "";
                  const replyMsgId = "a-" + Date.now().toString(36);
                  getSessionPool().append(sid, {
                    id: replyMsgId,
                    role: "agent",
                    text: replyText,
                  });
                  sendToHost({
                    v: 1,
                    type: "agent.message.end",
                    session: sid,
                    msg_id: replyMsgId,
                    text: replyText,
                  });
                },
                onError: (err) => {
                  // Surface errors back to note.md host as an error frame.
                  sendToHost({
                    v: 1,
                    type: "error",
                    code: "dispatch_error",
                    message: String(err),
                  });
                },
              });

            await core.channel.reply.withReplyDispatcher({
              dispatcher,
              onSettled: () => {
                markDispatchIdle();
              },
              run: () =>
                core.channel.reply.dispatchReplyFromConfig({
                  ctx: ctxPayload,
                  cfg,
                  dispatcher,
                  replyOptions,
                }),
            });
          } catch (err) {
            sendToHost({
              v: 1,
              type: "error",
              code: "dispatch_error",
              message: String(err),
            });
          }
        })();
      }
      break;

    case "session.list":
      sendToHost({
        v: 1,
        type: "session.list.result",
        sessions: getSessionPool().list(),
      });
      break;

    case "session.new":
      {
        const s = getSessionPool().create((f.title as string | undefined) ?? undefined);
        sendToHost({
          v: 1,
          type: "session.list.result",
          sessions: getSessionPool().list(),
          focus: s.id,
        });
      }
      break;

    case "session.replay":
      {
        const sid = f.id as string;
        const after = (f.after_msg_id as string | undefined) ?? "";
        const msgs = after
          ? getSessionPool().messagesAfter(sid, after)
          : getSessionPool().messages(sid);
        for (const m of msgs) {
          sendToHost({
            v: 1,
            type: m.role === "agent" ? "agent.message.end" : "user.message",
            session: sid,
            msg_id: m.id,
            text: m.text,
          });
        }
      }
      break;

    default:
      // Unknown frame: ignore.
      break;
  }
}

let cachedDefaultSession: string | null = null;
function getOrCreateDefaultSession(): string {
  if (cachedDefaultSession && getSessionPool().get(cachedDefaultSession)) {
    return cachedDefaultSession;
  }
  const s = getSessionPool().create("New chat");
  cachedDefaultSession = s.id;
  return s.id;
}

export { stopServer, ensureServer };
