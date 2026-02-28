import fs from "node:fs/promises";
import path from "node:path";
import type { RunSpecV1 } from "../../../packages/contracts/src";

type AuthPreference = "auto" | "oauth" | "api_key";
type WebProvider = "searxng" | "openai" | "brave" | "perplexity" | "brightdata" | "auto";
type WebSearchServiceLike = {
  search: (
    query: string,
    options: {
      provider?: WebProvider;
      authSessionId: string;
      authPreference?: AuthPreference;
    }
  ) => Promise<{ provider: "searxng" | "openai" | "brave" | "perplexity" | "brightdata"; text: string } | null>;
};
type HybridLlmServiceLike = {
  generateText: (
    sessionId: string,
    input: string,
    options?: { authPreference?: AuthPreference }
  ) => Promise<{ text: string } | null>;
};
type OutboundNotificationStoreLike = {
  enqueue: (notification: {
    sessionId: string;
    kind?: "text" | "file";
    text?: string;
    filePath?: string;
    fileName?: string;
    mimeType?: string;
    caption?: string;
    jobId?: string;
    status?: string;
  }) => Promise<unknown>;
};
type RunSpecStoreLike = {
  setStatus: (
    runId: string,
    status: "queued" | "awaiting_approval" | "running" | "completed" | "failed" | "cancelled",
    options?: { message?: string; payload?: Record<string, unknown> }
  ) => Promise<unknown>;
  updateStep: (
    runId: string,
    stepId: string,
    input: {
      status: "pending" | "approval_required" | "approved" | "running" | "completed" | "failed" | "cancelled" | "skipped";
      message?: string;
      output?: Record<string, unknown>;
      attempts?: number;
    }
  ) => Promise<unknown>;
};

export async function executeRunSpec(input: {
  runId: string;
  sessionId: string;
  authSessionId: string;
  authPreference: AuthPreference;
  runSpec: RunSpecV1;
  approvedStepIds: string[];
  workspaceDir: string;
  webSearchService: WebSearchServiceLike;
  llmService: HybridLlmServiceLike;
  notificationStore: OutboundNotificationStoreLike;
  runSpecStore: RunSpecStoreLike;
  reportProgress: (progress: { message: string; step?: string; percent?: number }) => Promise<void>;
}): Promise<{
  summary: string;
  responseText: string;
  outputPath?: string;
  provider?: string;
}> {
  const approved = new Set(input.approvedStepIds.map((item) => item.trim()).filter(Boolean));
  const state: {
    query?: string;
    provider?: WebProvider;
    searchText?: string;
    fileFormat?: "md" | "txt" | "doc";
    filePath?: string;
    fileName?: string;
    caption?: string;
  } = {};

  await input.runSpecStore.setStatus(input.runId, "running", {
    message: `Running ${input.runSpec.steps.length} steps`
  });

  const totalSteps = input.runSpec.steps.length;
  for (let index = 0; index < totalSteps; index += 1) {
    const step = input.runSpec.steps[index];
    const percent = Math.round((index / Math.max(1, totalSteps)) * 100);
    const label = `${step.type}:${step.id}`;

    if (step.approval?.required && !approved.has(step.id)) {
      await input.runSpecStore.updateStep(input.runId, step.id, {
        status: "approval_required",
        message: `Missing approval for ${step.id}`
      });
      await input.runSpecStore.setStatus(input.runId, "failed", {
        message: `approval_missing:${step.id}`
      });
      return {
        summary: "run_spec_approval_missing",
        responseText: `Run blocked: missing approval for step ${step.id}.`
      };
    }

    if (step.approval?.required && approved.has(step.id)) {
      await input.runSpecStore.updateStep(input.runId, step.id, {
        status: "approved",
        message: "Approved"
      });
    }

    await input.runSpecStore.updateStep(input.runId, step.id, {
      status: "running",
      message: `Executing ${step.type}`,
      attempts: 1
    });
    await input.reportProgress({
      step: label,
      message: `Executing ${step.name}...`,
      percent
    });

    try {
      if (step.type === "web.search") {
        const query = String(step.input.query ?? "").trim();
        const provider = normalizeProvider(step.input.provider) ?? "auto";
        if (!query) {
          throw new Error("run_spec_missing_query");
        }
        const result = await input.webSearchService.search(query, {
          provider,
          authSessionId: input.authSessionId,
          authPreference: input.authPreference
        });
        if (!result?.text?.trim()) {
          throw new Error("run_spec_empty_search_result");
        }
        state.query = query;
        state.provider = result.provider;
        state.searchText = result.text.trim();
        await input.runSpecStore.updateStep(input.runId, step.id, {
          status: "completed",
          message: `Search done via ${result.provider}`,
          output: { provider: result.provider }
        });
        continue;
      }

      if (step.type === "doc.compose") {
        if (!state.searchText || !state.query) {
          throw new Error("run_spec_missing_search_context");
        }
        const format = normalizeFileFormat(step.input.fileFormat) ?? "md";
        const synthesized = await composeDocument({
          llmService: input.llmService,
          authSessionId: input.authSessionId,
          authPreference: input.authPreference,
          query: state.query,
          provider: state.provider ?? "auto",
          sourceText: state.searchText,
          fileFormat: format
        });
        state.searchText = synthesized;
        state.fileFormat = format;
        await input.runSpecStore.updateStep(input.runId, step.id, {
          status: "completed",
          message: `Drafted ${format.toUpperCase()} document`
        });
        continue;
      }

      if (step.type === "file.write") {
        if (!state.searchText) {
          throw new Error("run_spec_missing_document_text");
        }
        const format = normalizeFileFormat(step.input.fileFormat) ?? state.fileFormat ?? "md";
        const baseName = sanitizeFileName(
          typeof step.input.fileName === "string" ? step.input.fileName : "research_note"
        );
        const fileName = ensureExtension(baseName || "research_note", format);
        const targetDir = path.resolve(input.workspaceDir, "notes", "generated");
        const targetPath = path.resolve(targetDir, fileName);
        if (!(targetPath === targetDir || targetPath.startsWith(`${targetDir}${path.sep}`))) {
          throw new Error("run_spec_workspace_boundary_violation");
        }
        await fs.mkdir(targetDir, { recursive: true });
        const content = state.searchText.endsWith("\n") ? state.searchText : `${state.searchText}\n`;
        await fs.writeFile(targetPath, content, "utf8");
        state.filePath = targetPath;
        state.fileName = fileName;
        state.fileFormat = format;
        await input.runSpecStore.updateStep(input.runId, step.id, {
          status: "completed",
          message: `Wrote ${fileName}`,
          output: { fileName }
        });
        continue;
      }

      if (step.type === "channel.send_attachment") {
        if (!state.filePath || !state.fileName) {
          throw new Error("run_spec_missing_output_file");
        }
        const caption = String(step.input.caption ?? `Research doc: ${state.query ?? "result"}`).trim();
        await input.notificationStore.enqueue({
          kind: "file",
          sessionId: input.sessionId,
          filePath: state.filePath,
          fileName: state.fileName,
          mimeType: resolveMimeType(state.fileFormat ?? "md"),
          caption
        });
        state.caption = caption;
        await input.runSpecStore.updateStep(input.runId, step.id, {
          status: "completed",
          message: `Attachment queued (${state.fileName})`,
          output: { fileName: state.fileName }
        });
        continue;
      }

      throw new Error(`run_spec_unsupported_step:${step.type}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await input.runSpecStore.updateStep(input.runId, step.id, {
        status: "failed",
        message: detail
      });
      await input.runSpecStore.setStatus(input.runId, "failed", {
        message: detail
      });
      return {
        summary: "run_spec_failed",
        responseText: `Run failed at step ${step.id} (${step.type}): ${detail}`,
        outputPath: state.filePath ? path.relative(input.workspaceDir, state.filePath).replace(/\\/g, "/") : undefined,
        provider: state.provider
      };
    }
  }

  await input.runSpecStore.setStatus(input.runId, "completed", {
    message: "All steps completed"
  });
  await input.reportProgress({
    step: "run_spec.completed",
    message: "Run complete.",
    percent: 100
  });

  const relativePath = state.filePath ? path.relative(input.workspaceDir, state.filePath).replace(/\\/g, "/") : undefined;
  return {
    summary: "run_spec_completed",
    responseText:
      relativePath && state.provider
        ? `Run complete via ${state.provider}. Wrote workspace/${relativePath} and sent it as an attachment.`
        : "Run complete.",
    outputPath: relativePath,
    provider: state.provider
  };
}

function normalizeProvider(raw: unknown): WebProvider | null {
  if (typeof raw !== "string") {
    return null;
  }
  const value = raw.trim().toLowerCase();
  if (value === "searxng" || value === "openai" || value === "brave" || value === "perplexity" || value === "brightdata" || value === "auto") {
    return value;
  }
  return null;
}

function normalizeFileFormat(raw: unknown): "md" | "txt" | "doc" | null {
  if (typeof raw !== "string") {
    return null;
  }
  const value = raw.trim().toLowerCase();
  if (value === "md" || value === "txt" || value === "doc") {
    return value;
  }
  return null;
}

function sanitizeFileName(raw: string): string {
  return raw
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function ensureExtension(fileName: string, format: "md" | "txt" | "doc"): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(`.${format}`)) {
    return fileName;
  }
  return `${fileName}.${format}`;
}

function resolveMimeType(format: "md" | "txt" | "doc"): string {
  if (format === "md") {
    return "text/markdown";
  }
  if (format === "txt") {
    return "text/plain";
  }
  return "application/msword";
}

async function composeDocument(input: {
  llmService: HybridLlmServiceLike;
  authSessionId: string;
  authPreference: AuthPreference;
  query: string;
  provider: WebProvider;
  sourceText: string;
  fileFormat: "md" | "txt" | "doc";
}): Promise<string> {
  const formatLabel = input.fileFormat === "md" ? "markdown" : input.fileFormat === "txt" ? "plain text" : "word-friendly plain text";
  const prompt = [
    "You are formatting research notes for delivery as a file attachment.",
    `Output format: ${formatLabel}.`,
    "Keep it concise and practical.",
    "Include sections: Summary, Top options, Comparison, Sources.",
    "Do not invent sources; only use what is provided.",
    "",
    `Query: ${input.query}`,
    `Provider: ${input.provider}`,
    "",
    "Search results:",
    input.sourceText
  ].join("\n");

  try {
    const generated = await input.llmService.generateText(input.authSessionId, prompt, {
      authPreference: input.authPreference
    });
    const text = generated?.text?.trim();
    if (text) {
      return text;
    }
  } catch {
    // deterministic fallback below
  }

  return [
    `Research notes for: ${input.query}`,
    `Source provider: ${input.provider}`,
    "",
    "Summary:",
    input.sourceText.slice(0, 2400)
  ].join("\n");
}
