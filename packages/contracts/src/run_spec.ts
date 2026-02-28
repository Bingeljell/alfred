import { z } from "zod";

export const RunSpecStepTypeSchema = z.enum([
  "web.search",
  "doc.compose",
  "file.write",
  "channel.send_attachment"
]);

export const RunSpecStepApprovalSchema = z.object({
  required: z.boolean().default(false),
  capability: z.string().min(1).default("file_write")
});

export const RunSpecStepSchema = z.object({
  id: z.string().min(1),
  type: RunSpecStepTypeSchema,
  name: z.string().min(1),
  input: z.record(z.string(), z.unknown()).default({}),
  timeoutMs: z.number().int().min(1000).max(10 * 60 * 1000).optional(),
  retries: z.number().int().min(0).max(5).optional(),
  approval: RunSpecStepApprovalSchema.optional()
});

export const RunSpecV1Schema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  goal: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).default({}),
  steps: z.array(RunSpecStepSchema).min(1).max(32)
});

export const RunSpecStepStateStatusSchema = z.enum([
  "pending",
  "approval_required",
  "approved",
  "running",
  "completed",
  "failed",
  "cancelled",
  "skipped"
]);

export const RunSpecTimelineEventTypeSchema = z.enum([
  "started",
  "step_status",
  "note",
  "approval_requested",
  "approval_granted",
  "completed",
  "failed",
  "cancelled"
]);

export type RunSpecStepType = z.infer<typeof RunSpecStepTypeSchema>;
export type RunSpecStep = z.infer<typeof RunSpecStepSchema>;
export type RunSpecV1 = z.infer<typeof RunSpecV1Schema>;
export type RunSpecStepStateStatus = z.infer<typeof RunSpecStepStateStatusSchema>;
export type RunSpecTimelineEventType = z.infer<typeof RunSpecTimelineEventTypeSchema>;
