import { z } from "zod";

export const JobStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelling",
  "cancelled"
]);

export const JobTypeSchema = z.enum(["stub_task", "chat_turn"]);

export const JobCreateSchema = z.object({
  type: JobTypeSchema,
  payload: z.record(z.string(), z.unknown()).default({}),
  priority: z.number().int().min(0).max(10).default(5),
  requestedSkill: z.string().optional()
});

export const JobSchema = z.object({
  id: z.string(),
  type: JobTypeSchema,
  payload: z.record(z.string(), z.unknown()),
  priority: z.number().int().min(0).max(10),
  status: JobStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  requestedSkill: z.string().optional(),
  retryOf: z.string().optional(),
  workerId: z.string().optional(),
  progress: z
    .object({
      at: z.string(),
      message: z.string(),
      step: z.string().optional(),
      percent: z.number().min(0).max(100).optional(),
      phase: z.string().optional(),
      details: z.record(z.string(), z.unknown()).optional()
    })
    .optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean().default(false)
    })
    .optional()
});

export const InboundMessageSchema = z.object({
  sessionId: z.string().min(1),
  text: z.string().min(1).optional(),
  requestJob: z.boolean().default(false),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export type JobStatus = z.infer<typeof JobStatusSchema>;
export type JobCreate = z.infer<typeof JobCreateSchema>;
export type Job = z.infer<typeof JobSchema>;
export type InboundMessage = z.infer<typeof InboundMessageSchema>;
