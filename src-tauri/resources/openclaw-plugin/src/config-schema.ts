// src/config-schema.ts
import { z } from "zod";

export const NotemdConfigSchema = z
  .object({
    socketPath: z.string().default("~/.openclaw/notemd.sock"),
    accessToken: z.string().min(32).optional(),
    maxClients: z.literal(1).default(1),
  })
  .strict();

export type NotemdConfig = z.infer<typeof NotemdConfigSchema>;
