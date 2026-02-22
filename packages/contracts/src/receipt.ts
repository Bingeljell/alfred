import { z } from "zod";

export const ReceiptSchema = z.object({
  receiptId: z.string(),
  jobId: z.string(),
  sessionId: z.string().default("local-session"),
  status: z.enum(["success", "failed", "cancelled", "partial"]),
  actions: z.array(
    z.object({
      at: z.string(),
      step: z.string(),
      detail: z.string().optional()
    })
  ),
  timing: z.object({
    queuedAt: z.string(),
    startedAt: z.string().optional(),
    endedAt: z.string().optional(),
    durationMs: z.number().int().nonnegative().default(0)
  }),
  outputSummary: z.string().optional()
});

export type Receipt = z.infer<typeof ReceiptSchema>;
