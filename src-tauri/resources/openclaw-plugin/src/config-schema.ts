// src/config-schema.ts
import { z } from "zod";

export const MdeditorConfigSchema = z
  .object({
    socketPath: z.string().default("~/.openclaw/mdeditor.sock"),
    accessToken: z.string().min(32).optional(),
    maxClients: z.literal(1).default(1),
  })
  .strict();

export type MdeditorConfig = z.infer<typeof MdeditorConfigSchema>;
