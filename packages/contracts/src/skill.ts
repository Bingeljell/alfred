import { z } from "zod";

export const SkillManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().optional(),
  entry: z.object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    cwd: z.string().optional()
  }),
  permissions: z
    .object({
      fs: z
        .object({
          read: z.array(z.string()).default([]),
          write: z.array(z.string()).default([])
        })
        .default({ read: [], write: [] }),
      network: z
        .object({
          allowlist: z.array(z.string()).default([])
        })
        .default({ allowlist: [] }),
      timeoutMs: z.number().int().min(100).max(600000).default(120000)
    })
    .default({
      fs: { read: [], write: [] },
      network: { allowlist: [] },
      timeoutMs: 120000
    })
});

export const SkillStructuredErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean().default(false),
  details: z.record(z.string(), z.unknown()).optional()
});

export type SkillManifest = z.infer<typeof SkillManifestSchema>;
export type SkillStructuredError = z.infer<typeof SkillStructuredErrorSchema>;
