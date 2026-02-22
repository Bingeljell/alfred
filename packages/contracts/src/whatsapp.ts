import { z } from "zod";

export const BaileysInboundMessageSchema = z.object({
  key: z.object({
    id: z.string().min(1),
    remoteJid: z.string().min(1)
  }),
  message: z
    .object({
      conversation: z.string().optional(),
      extendedTextMessage: z
        .object({
          text: z.string().optional()
        })
        .optional()
    })
    .optional(),
  pushName: z.string().optional(),
  messageTimestamp: z.number().optional()
});

export type BaileysInboundMessage = z.infer<typeof BaileysInboundMessageSchema>;
