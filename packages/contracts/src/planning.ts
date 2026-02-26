import { z } from "zod";
import { RunSpecV1Schema } from "./run_spec";

export const PlannerSourceSchema = z.enum(["gateway", "worker"]);

export const PlanProposalSchema = z.object({
  version: z.literal(1),
  proposalId: z.string().min(1),
  sessionKey: z.string().min(1),
  source: PlannerSourceSchema,
  parentRunId: z.string().min(1).optional(),
  rationale: z.string().min(1).default(""),
  requestedAt: z.string().min(1),
  suggestedRunSpec: RunSpecV1Schema,
  budget: z
    .object({
      maxTokens: z.number().int().min(1).optional(),
      maxTimeMs: z.number().int().min(1000).optional(),
      maxToolCalls: z.number().int().min(1).optional()
    })
    .default({})
});

export const PlanDecisionStatusSchema = z.enum(["approved", "revise", "rejected"]);

export const PlanDecisionSchema = z.object({
  version: z.literal(1),
  proposalId: z.string().min(1),
  sessionKey: z.string().min(1),
  decision: PlanDecisionStatusSchema,
  decidedAt: z.string().min(1),
  reason: z.string().min(1).default(""),
  approvedRunSpec: RunSpecV1Schema.optional(),
  revisionNotes: z.array(z.string().min(1)).default([])
});

export const RunSpecLockSchema = z.object({
  version: z.literal(1),
  runId: z.string().min(1),
  sessionKey: z.string().min(1),
  runSpecId: z.string().min(1),
  runSpecRevision: z.number().int().min(1).default(1),
  runSpecHash: z.string().min(1),
  approvedAt: z.string().min(1),
  approvedBy: z.literal("gateway"),
  sourceProposalId: z.string().min(1).optional()
});

export type PlannerSource = z.infer<typeof PlannerSourceSchema>;
export type PlanProposal = z.infer<typeof PlanProposalSchema>;
export type PlanDecisionStatus = z.infer<typeof PlanDecisionStatusSchema>;
export type PlanDecision = z.infer<typeof PlanDecisionSchema>;
export type RunSpecLock = z.infer<typeof RunSpecLockSchema>;
