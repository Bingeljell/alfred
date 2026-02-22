import path from "node:path";
import { z } from "zod";

const EnvSchema = z.object({
  PORT: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 3000))
    .pipe(z.number().int().min(1).max(65535)),
  STATE_DIR: z.string().optional().default("./state"),
  WORKER_POLL_MS: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 250))
    .pipe(z.number().int().min(25).max(60000)),
  NOTIFICATION_POLL_MS: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 250))
    .pipe(z.number().int().min(25).max(60000)),
  REMINDER_POLL_MS: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 500))
    .pipe(z.number().int().min(100).max(60000))
});

export type AppConfig = {
  port: number;
  stateDir: string;
  workerPollMs: number;
  notificationPollMs: number;
  reminderPollMs: number;
};

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = EnvSchema.parse(env);

  return {
    port: parsed.PORT,
    stateDir: path.resolve(parsed.STATE_DIR),
    workerPollMs: parsed.WORKER_POLL_MS,
    notificationPollMs: parsed.NOTIFICATION_POLL_MS,
    reminderPollMs: parsed.REMINDER_POLL_MS
  };
}
