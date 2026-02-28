import type { RunSpecV1 } from "../../../../packages/contracts/src";
import type { WorkerProcessor } from "../worker";
import { executeRunSpec } from "../run_spec_executor";

type AuthPreference = "auto" | "oauth" | "api_key";
type SearchProvider = "searxng" | "openai" | "brave" | "perplexity" | "brightdata" | "auto";
type AttachmentFormat = "md" | "txt" | "doc";
type ResolvedProvider = "searxng" | "openai" | "brave" | "perplexity" | "brightdata";

type SearchHit = {
  title: string;
  url: string;
  snippet: string;
  provider: ResolvedProvider;
  domain: string;
};

type RankingCandidate = {
  name: string;
  category: string;
  score: number;
  pros: string[];
  cons: string[];
  rationale: string;
  evidenceUrls: string[];
};

type RankingResult = {
  confidence: "low" | "medium" | "high";
  topPick: string;
  candidates: RankingCandidate[];
  ambiguityReasons: string[];
  followUpQuestions: string[];
  summary: string;
};

export function createWorkerProcessor(input: {
  config: {
    alfredWorkspaceDir: string;
    alfredWebSearchProvider: SearchProvider;
  };
  webSearchService: {
    search: (
      query: string,
      options: {
        provider?: SearchProvider;
        authSessionId: string;
        authPreference?: AuthPreference;
      }
    ) => Promise<{ provider: "searxng" | "openai" | "brave" | "perplexity" | "brightdata"; text: string } | null>;
  };
  llmService: {
    generateText: (
      sessionId: string,
      input: string,
      options?: { authPreference?: AuthPreference }
    ) => Promise<{ text: string } | null>;
  };
  pagedResponseStore: {
    setPages: (sessionId: string, pages: string[]) => Promise<void>;
    clear: (sessionId: string) => Promise<void>;
  };
  notificationStore: {
    enqueue: (item: {
      sessionId: string;
      status?: string;
      text?: string;
      jobId?: string;
      kind?: "text" | "file";
      filePath?: string;
      fileName?: string;
      mimeType?: string;
      caption?: string;
    }) => Promise<unknown>;
  };
  runSpecStore: {
    put: (input: {
      runId: string;
      sessionId: string;
      spec: RunSpecV1;
      status: "queued" | "awaiting_approval" | "running" | "completed" | "failed" | "cancelled";
      jobId?: string;
      approvedStepIds?: string[];
      parentRunId?: string;
    }) => Promise<unknown>;
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
}): WorkerProcessor {
  return async (job, context) => {
    const taskType = String(job.payload.taskType ?? "").trim().toLowerCase();
    const sessionId = typeof job.payload.sessionId === "string" ? job.payload.sessionId : "";
    const authSessionId =
      typeof job.payload.authSessionId === "string" && job.payload.authSessionId.trim()
        ? job.payload.authSessionId.trim()
        : sessionId;
    const authPreference = normalizeAuthPreference(job.payload.authPreference);

    if (taskType === "run_spec") {
      const runSpec = parseRunSpec(job.payload.runSpec);
      if (!runSpec) {
        throw new Error("RunSpec payload is missing or invalid.");
      }
      const runId = typeof job.payload.runSpecRunId === "string" ? job.payload.runSpecRunId.trim() : "";
      const approvedStepIds = Array.isArray(job.payload.approvedStepIds)
        ? job.payload.approvedStepIds
            .map((item) => String(item ?? "").trim())
            .filter((item) => item.length > 0)
        : [];

      const effectiveRunId = runId || job.id;
      await input.runSpecStore.put({
        runId: effectiveRunId,
        sessionId: sessionId || authSessionId,
        spec: runSpec,
        status: "running",
        jobId: job.id,
        approvedStepIds
      });

      const runResult = await executeRunSpec({
        runId: effectiveRunId,
        sessionId: sessionId || authSessionId,
        authSessionId: authSessionId || sessionId,
        authPreference,
        runSpec,
        approvedStepIds,
        workspaceDir: input.config.alfredWorkspaceDir,
        webSearchService: input.webSearchService,
        llmService: input.llmService,
        notificationStore: input.notificationStore,
        runSpecStore: input.runSpecStore,
        reportProgress: context.reportProgress
      });
      if (runResult.summary === "run_spec_failed" || runResult.summary === "run_spec_approval_missing") {
        throw new Error(runResult.responseText || runResult.summary);
      }
      return runResult;
    }

    if (taskType === "web_to_file") {
      const query = String(job.payload.query ?? "").trim();
      const legacySpec = buildLegacyWebToFileRunSpec({
        runId: job.id,
        query,
        provider: normalizeWebSearchProvider(job.payload.provider) ?? input.config.alfredWebSearchProvider,
        fileFormat: normalizeAttachmentFormat(job.payload.fileFormat) ?? "md",
        fileName: typeof job.payload.fileName === "string" ? job.payload.fileName : undefined,
        sessionId
      });
      await input.runSpecStore.put({
        runId: job.id,
        sessionId: sessionId || authSessionId,
        spec: legacySpec,
        status: "running",
        jobId: job.id,
        approvedStepIds: legacySpec.steps.filter((step) => step.approval?.required !== true).map((step) => step.id)
      });

      const runResult = await executeRunSpec({
        runId: job.id,
        sessionId: sessionId || authSessionId,
        authSessionId: authSessionId || sessionId,
        authPreference,
        runSpec: legacySpec,
        approvedStepIds: legacySpec.steps.map((step) => step.id),
        workspaceDir: input.config.alfredWorkspaceDir,
        webSearchService: input.webSearchService,
        llmService: input.llmService,
        notificationStore: input.notificationStore,
        runSpecStore: input.runSpecStore,
        reportProgress: context.reportProgress
      });
      if (runResult.summary === "run_spec_failed" || runResult.summary === "run_spec_approval_missing") {
        throw new Error(runResult.responseText || runResult.summary);
      }
      return runResult;
    }

    if (taskType === "chat_turn") {
      const turnInput = String(job.payload.text ?? "").trim();
      if (!turnInput) {
        return {
          summary: "chat_turn_missing_input",
          responseText: "Follow-up could not run: missing input text."
        };
      }
      await context.reportProgress({
        step: "planning",
        message: "Running queued follow-up turn..."
      });
      const generated = await input.llmService.generateText(authSessionId || sessionId, turnInput, { authPreference });
      const text = generated?.text?.trim();
      if (!text) {
        return {
          summary: "chat_turn_no_response",
          responseText: "No model response is available for this follow-up turn."
        };
      }
      return {
        summary: "chat_turn_completed",
        responseText: text
      };
    }

    if (taskType === "agentic_turn") {
      const goal = String(job.payload.query ?? job.payload.goal ?? job.payload.text ?? "").trim();
      const searchGoal = buildSearchGoal(goal);
      const requestedProvider = normalizeWebSearchProvider(job.payload.provider) ?? input.config.alfredWebSearchProvider;
      const maxRetries = clampInt(job.payload.maxRetries, 0, 5, 1);
      const timeBudgetMs = clampInt(job.payload.timeBudgetMs, 5000, 10 * 60 * 1000, 120_000);
      const tokenBudget = clampInt(job.payload.tokenBudget, 128, 50_000, 8_000);
      const progressPulseMs = 30_000;
      const runStartedAt = Date.now();
      const deadlineAt = runStartedAt + timeBudgetMs;
      const searchBudgetMs = Math.min(35_000, Math.max(8_000, Math.floor(timeBudgetMs * 0.35)));
      const rankingBudgetMs = Math.min(18_000, Math.max(8_000, Math.floor(timeBudgetMs * 0.2)));
      const synthesisBudgetMs = Math.min(42_000, Math.max(12_000, Math.floor(timeBudgetMs * 0.42)));

      if (!goal) {
        return {
          summary: "agentic_turn_missing_goal",
          responseText: "I could not start this task because no goal text was provided."
        };
      }

      await context.reportProgress({
        step: "planning",
        phase: "plan",
        message: `Task accepted. Search focus prepared: ${searchGoal.slice(0, 90)}${searchGoal.length > 90 ? "..." : ""}`,
        details: {
          requestedProvider,
          tokenBudget,
          searchGoal
        }
      });

      const primaryProvider = resolvePrimaryProvider(requestedProvider);
      const fallbackProviders = resolveFallbackProviders(primaryProvider);
      const providersUsed: ResolvedProvider[] = [];
      let searchError: unknown = null;
      let retriesUsed = 0;

      const runProviderSearch = async (
        provider: ResolvedProvider,
        retries: number,
        query: string
      ): Promise<{ provider: ResolvedProvider; text: string; hits: SearchHit[] } | null> => {
        for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
          await context.reportProgress({
            step: "searching",
            phase: "retrieve",
            message: `Retrieving sources via ${provider} (attempt ${attempt}/${retries + 1})...`,
            details: {
              provider,
              attempt,
              maxAttempts: retries + 1,
              query
            }
          });
          try {
            const remainingMs = msRemaining(deadlineAt, 3000);
            const attemptBudgetMs = Math.max(3000, Math.min(searchBudgetMs, remainingMs));
            const result = await withProgressPulse(
              () =>
                withTimeout(
                  input.webSearchService.search(query, {
                    provider,
                    authSessionId,
                    authPreference
                  }),
                  attemptBudgetMs,
                  "agentic_turn_search_time_budget_exceeded"
                ),
              {
                intervalMs: progressPulseMs,
                onPulse: async (elapsedMs) => {
                  await context.reportProgress({
                    step: "searching",
                    phase: "retrieve",
                    message: `Still retrieving via ${provider} (${Math.floor(elapsedMs / 1000)}s elapsed)...`,
                    details: {
                      provider,
                      elapsedSec: Math.floor(elapsedMs / 1000),
                      query
                    }
                  });
                }
              }
            );
            const text = result?.text?.trim();
            const resolvedProvider = result?.provider;
            if (!text || !resolvedProvider) {
              continue;
            }
            const hits = extractSearchHits(text, 24, resolvedProvider);
            if (hits.length === 0) {
              continue;
            }
            return {
              provider: resolvedProvider,
              text,
              hits
            };
          } catch (error) {
            searchError = error;
            retriesUsed += 1;
          }

          if (attempt <= retries) {
            await context.reportProgress({
              step: "retrying",
              phase: "retrieve",
              message: `Source retrieval stalled on ${provider}; retrying (${attempt}/${retries})...`,
              details: {
                provider,
                retry: attempt,
                maxRetries: retries
              }
            });
          }
        }
        return null;
      };

      const primary = await runProviderSearch(primaryProvider, maxRetries, searchGoal);
      if (!primary) {
        const reason = searchError instanceof Error ? searchError.message : "no_result";
        return {
          summary: "agentic_turn_no_context",
          responseText: `I couldn't gather web context for this request. Reason: ${reason}`
        };
      }
      providersUsed.push(primary.provider);

      let mergedHits = rankSearchHitsForGoal(primary.hits, goal);
      const primaryCoverage = evaluateCoverage(mergedHits);
      await context.reportProgress({
        step: "searching",
        phase: "retrieve",
        message: `Retrieved ${primaryCoverage.hitCount} sources across ${primaryCoverage.distinctDomainCount} domains via ${primary.provider}.`,
        details: {
          provider: primary.provider,
          hitCount: primaryCoverage.hitCount,
          domainCount: primaryCoverage.distinctDomainCount
        }
      });

      if (requestedProvider === "auto" && primary.provider === "searxng" && primaryCoverage.weakCoverage) {
        for (const fallbackProvider of fallbackProviders) {
          await context.reportProgress({
            step: "searching",
            phase: "fallback_retrieve",
            message: `Coverage looks weak on ${primary.provider}; running fallback retrieval via ${fallbackProvider}.`,
            details: {
              primaryProvider: primary.provider,
              fallbackProvider
            }
          });
          const fallback = await runProviderSearch(fallbackProvider, 0, searchGoal);
          if (!fallback) {
            continue;
          }
          providersUsed.push(fallback.provider);
          mergedHits = rankSearchHitsForGoal(mergeSearchHits(mergedHits, fallback.hits, 28), goal);
          const mergedCoverage = evaluateCoverage(mergedHits);
          await context.reportProgress({
            step: "searching",
            phase: "fallback_retrieve",
            message: `Fallback retrieval added context: ${mergedCoverage.hitCount} total sources across ${mergedCoverage.distinctDomainCount} domains.`,
            details: {
              provider: fallback.provider,
              mergedHitCount: mergedCoverage.hitCount,
              mergedDomainCount: mergedCoverage.distinctDomainCount
            }
          });
          if (!mergedCoverage.weakCoverage) {
            break;
          }
        }
      }

      const supplementalQuery = buildSupplementalSearchGoal(goal, searchGoal, mergedHits);
      if (
        supplementalQuery &&
        supplementalQuery !== searchGoal &&
        msRemaining(deadlineAt, 0) > Math.max(5000, Math.floor(searchBudgetMs * 0.6))
      ) {
        await context.reportProgress({
          step: "searching",
          phase: "fallback_retrieve",
          message: "Running one supplemental retrieval pass to improve evidence coverage.",
          details: {
            query: supplementalQuery
          }
        });
        const supplemental = await runProviderSearch(primaryProvider, 0, supplementalQuery);
        if (supplemental) {
          providersUsed.push(supplemental.provider);
          mergedHits = rankSearchHitsForGoal(mergeSearchHits(mergedHits, supplemental.hits, 30), goal);
        }
      }

      const compactEvidence = compactSearchHitsForSynthesis(mergedHits, 14);
      await context.reportProgress({
        step: "ranking",
        phase: "rank",
        message: `Ranking ${compactEvidence.length} candidates against your goal.`,
        details: {
          candidateCount: compactEvidence.length,
          providersUsed
        }
      });

      const rankPrompt = buildAgenticRankingPrompt(goal, compactEvidence);
      let ranking: RankingResult | null = null;
      let rankingRaw = "";
      try {
        const ranked = await withTimeout(
          input.llmService.generateText(authSessionId || sessionId, rankPrompt, { authPreference }),
          Math.max(3000, Math.min(rankingBudgetMs, msRemaining(deadlineAt, 3000))),
          "agentic_turn_ranking_time_budget_exceeded"
        );
        rankingRaw = String(ranked?.text ?? "");
        ranking = parseRankingResult(rankingRaw);
      } catch {
        ranking = null;
      }

      if (!ranking && rankingRaw.trim()) {
        try {
          const repairPrompt = buildRankingRepairPrompt(goal, rankingRaw);
          const repaired = await withTimeout(
            input.llmService.generateText(authSessionId || sessionId, repairPrompt, { authPreference }),
            Math.max(2500, Math.min(8000, msRemaining(deadlineAt, 2500))),
            "agentic_turn_ranking_repair_time_budget_exceeded"
          );
          ranking = parseRankingResult(repaired?.text ?? "");
        } catch {
          ranking = null;
        }
      }

      if (!ranking) {
        ranking = buildHeuristicRanking(goal, compactEvidence);
      }

      if (!ranking) {
        const fallbackText = renderNoRankingFallback(goal, mergedHits, providersUsed);
        return finalizePagedAgenticResponse({
          sessionId,
          fullText: fallbackText,
          pagedResponseStore: input.pagedResponseStore,
          summary: `agentic_turn_${primary.provider}`,
          providersUsed,
          retriesUsed,
          tokenBudget,
          confidence: "low",
          recommendationMode: "rank_only"
        });
      }

      if (ranking.ambiguityReasons.length > 0 && ranking.followUpQuestions.length > 0) {
        const clarify = renderClarificationRequest(goal, ranking);
        return {
          summary: "agentic_turn_needs_clarification",
          responseText: clarify,
          providersUsed,
          confidence: ranking.confidence,
          recommendationMode: "rank_only",
          retriesUsed,
          tokenBudget
        };
      }

      const quality = evaluateRecommendationQuality(mergedHits, ranking);
      if (!quality.passed) {
        const gated = renderQualityGateFallback(goal, ranking, mergedHits, quality);
        return finalizePagedAgenticResponse({
          sessionId,
          fullText: gated,
          pagedResponseStore: input.pagedResponseStore,
          summary: `agentic_turn_${primary.provider}`,
          providersUsed,
          retriesUsed,
          tokenBudget,
          confidence: ranking.confidence,
          recommendationMode: "rank_only"
        });
      }

      await context.reportProgress({
        step: "synthesizing",
        phase: "synth",
        message: "Composing final recommendation from ranked evidence.",
        details: {
          topPick: ranking.topPick,
          confidence: ranking.confidence
        }
      });

      const synthesisPrompt = buildAgenticSynthesisPrompt(goal, ranking, compactEvidence, providersUsed);
      let synthesisText: string | null = null;
      try {
        const generated = await withProgressPulse(
          () =>
            withTimeout(
              input.llmService.generateText(authSessionId || sessionId, synthesisPrompt, { authPreference }),
              Math.max(4000, Math.min(synthesisBudgetMs, msRemaining(deadlineAt, 4000))),
              "agentic_turn_synthesis_time_budget_exceeded"
            ),
          {
            intervalMs: progressPulseMs,
            onPulse: async (elapsedMs) => {
              await context.reportProgress({
                step: "synthesizing",
                phase: "synth",
                message: `Still composing recommendation (${Math.floor(elapsedMs / 1000)}s elapsed)...`,
                details: {
                  elapsedSec: Math.floor(elapsedMs / 1000),
                  topPick: ranking?.topPick ?? ""
                }
              });
            }
          }
        );
        const composed = typeof generated?.text === "string" ? generated.text.trim() : "";
        synthesisText = composed || null;
      } catch {
        synthesisText = null;
      }

      if (!synthesisText && msRemaining(deadlineAt, 0) > 2500) {
        await context.reportProgress({
          step: "synthesizing",
          phase: "synth",
          message: "Deep synthesis exceeded budget; producing concise recommendation.",
          details: {
            topPick: ranking.topPick
          }
        });
        try {
          const concisePrompt = buildConciseSynthesisPrompt(goal, ranking, compactEvidence);
          const concise = await withTimeout(
            input.llmService.generateText(authSessionId || sessionId, concisePrompt, { authPreference }),
            Math.max(2500, Math.min(9000, msRemaining(deadlineAt, 2500))),
            "agentic_turn_concise_synthesis_time_budget_exceeded"
          );
          const composed = typeof concise?.text === "string" ? concise.text.trim() : "";
          synthesisText = composed || null;
        } catch {
          synthesisText = null;
        }
      }

      const fullText = synthesisText || renderRankOnlyRecommendation(goal, ranking, mergedHits, providersUsed);
      return finalizePagedAgenticResponse({
        sessionId,
        fullText,
        pagedResponseStore: input.pagedResponseStore,
        summary: `agentic_turn_${primary.provider}`,
        providersUsed,
        retriesUsed,
        tokenBudget,
        confidence: ranking.confidence,
        recommendationMode: synthesisText ? "rank_plus_synthesis" : "rank_only",
        sourceStats: {
          hits: mergedHits.length,
          distinctDomains: countDistinctDomains(mergedHits)
        },
        elapsedSec: Math.max(1, Math.floor((Date.now() - runStartedAt) / 1000))
      });
    }

    if (taskType !== "web_search") {
      const action = String(job.payload.action ?? job.payload.text ?? job.type);
      return {
        summary: `processed:${action}`,
        processedAt: new Date().toISOString()
      };
    }

    const query = String(job.payload.query ?? "").trim();
    const provider = normalizeWebSearchProvider(job.payload.provider) ?? input.config.alfredWebSearchProvider;
    const maxRetries = clampInt(job.payload.maxRetries, 0, 5, 1);
    const timeBudgetMs = clampInt(job.payload.timeBudgetMs, 5000, 10 * 60 * 1000, 120_000);
    const tokenBudget = clampInt(job.payload.tokenBudget, 128, 50_000, 8_000);

    if (!query) {
      return {
        summary: "web_search_missing_query",
        responseText: "Web search task failed: missing query."
      };
    }

    await context.reportProgress({
      step: "queued",
      message: `Starting web search for: ${query.slice(0, 140)}`
    });

    let attempt = 0;
    let resultText = "";
    let resultProvider: "searxng" | "openai" | "brave" | "perplexity" | "brightdata" | null = null;
    let lastError: unknown = null;

    while (attempt <= maxRetries) {
      attempt += 1;
      await context.reportProgress({
        step: "searching",
        message: `Searching via ${provider} (attempt ${attempt}/${maxRetries + 1})...`
      });
      try {
        const result = await withTimeout(
          input.webSearchService.search(query, {
            provider,
            authSessionId,
            authPreference
          }),
          timeBudgetMs,
          "web_search_time_budget_exceeded"
        );
        if (result?.text?.trim()) {
          resultText = result.text.trim();
          resultProvider = result.provider;
          break;
        }
      } catch (error) {
        lastError = error;
      }

      if (attempt <= maxRetries) {
        await context.reportProgress({
          step: "retrying",
          message: `Retrying web search (${attempt}/${maxRetries})...`
        });
      }
    }

    if (!resultText || !resultProvider) {
      const reason = lastError instanceof Error ? lastError.message : "no_result";
      return {
        summary: "web_search_no_results",
        responseText: `No web search result is available for this query. Reason: ${reason}`
      };
    }

    await context.reportProgress({
      step: "synthesizing",
      message: "Formatting final response..."
    });
    const fullText = `Web search provider: ${resultProvider}\n${resultText}`;
    const pages = paginateResponse(fullText, 1400, 8);
    const firstPage = pages[0] ?? fullText;
    if (sessionId && pages.length > 1) {
      await input.pagedResponseStore.setPages(sessionId, pages.slice(1));
    } else if (sessionId) {
      await input.pagedResponseStore.clear(sessionId);
    }

    const responseText =
      pages.length > 1 ? `${firstPage}\n\nReply #next for more (${pages.length - 1} remaining).` : firstPage;

    return {
      summary: `web_search_${resultProvider}`,
      responseText,
      provider: resultProvider,
      pageCount: pages.length,
      retriesUsed: Math.max(0, attempt - 1),
      tokenBudget
    };
  };
}

function normalizeAuthPreference(raw: unknown): AuthPreference {
  if (typeof raw !== "string") {
    return "auto";
  }
  const value = raw.trim().toLowerCase();
  if (value === "oauth") {
    return "oauth";
  }
  if (value === "api_key") {
    return "api_key";
  }
  return "auto";
}

function normalizeWebSearchProvider(raw: unknown): SearchProvider | null {
  if (typeof raw !== "string") {
    return null;
  }
  const value = raw.trim().toLowerCase();
  if (value === "searxng" || value === "openai" || value === "brave" || value === "perplexity" || value === "brightdata" || value === "auto") {
    return value;
  }
  return null;
}

function normalizeAttachmentFormat(raw: unknown): AttachmentFormat | null {
  if (typeof raw !== "string") {
    return null;
  }
  const value = raw.trim().toLowerCase();
  if (value === "md" || value === "txt" || value === "doc") {
    return value;
  }
  return null;
}

function parseRunSpec(raw: unknown): RunSpecV1 | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (record.version !== 1) {
    return null;
  }
  if (typeof record.id !== "string" || !record.id.trim()) {
    return null;
  }
  if (typeof record.goal !== "string" || !record.goal.trim()) {
    return null;
  }
  if (!Array.isArray(record.steps) || record.steps.length === 0) {
    return null;
  }

  const steps = record.steps
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const step = item as Record<string, unknown>;
      if (typeof step.id !== "string" || !step.id.trim()) {
        return null;
      }
      if (typeof step.type !== "string" || !step.type.trim()) {
        return null;
      }
      if (typeof step.name !== "string" || !step.name.trim()) {
        return null;
      }
      const parsedInput = step.input && typeof step.input === "object" ? (step.input as Record<string, unknown>) : {};
      const approval =
        step.approval && typeof step.approval === "object"
          ? {
              required: Boolean((step.approval as Record<string, unknown>).required),
              capability:
                typeof (step.approval as Record<string, unknown>).capability === "string"
                  ? String((step.approval as Record<string, unknown>).capability)
                  : "file_write"
            }
          : undefined;
      return {
        id: step.id.trim(),
        type: step.type.trim() as "web.search" | "doc.compose" | "file.write" | "channel.send_attachment",
        name: step.name.trim(),
        input: parsedInput,
        approval
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  if (steps.length === 0) {
    return null;
  }

  return {
    version: 1,
    id: record.id.trim(),
    goal: record.goal.trim(),
    metadata: record.metadata && typeof record.metadata === "object" ? (record.metadata as Record<string, unknown>) : {},
    steps
  };
}

function buildSearchGoal(goal: string): string {
  const trimmed = goal.trim();
  if (!trimmed) {
    return "";
  }
  let normalized = trimmed
    .replace(/^[\s,]*(hey|hi|hello)\s+alfred[,\s]*/i, "")
    .replace(/^[\s,]*(hey|hi|hello)[,\s]*/i, "")
    .replace(/\b(can you|could you|please|for me)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  normalized = normalized.replace(/[?.!]+$/g, "").trim();
  return normalized || trimmed;
}

function buildSupplementalSearchGoal(goal: string, primaryQuery: string, hits: SearchHit[]): string | null {
  const coverage = evaluateCoverage(hits);
  if (!coverage.weakCoverage) {
    return null;
  }
  const hint = /recommend|best|compare|vs|versus/i.test(goal)
    ? "official docs benchmarks pricing comparison"
    : "official docs comparison";
  const supplemental = `${primaryQuery} ${hint}`.replace(/\s+/g, " ").trim();
  return supplemental.length > primaryQuery.length ? supplemental : null;
}

function rankSearchHitsForGoal(hits: SearchHit[], goal: string): SearchHit[] {
  if (hits.length <= 1) {
    return hits;
  }
  const tokens = new Set(
    goal
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((item) => item.length >= 3)
  );
  const scored = hits.map((hit, index) => {
    const text = `${hit.title} ${hit.snippet}`.toLowerCase();
    let overlap = 0;
    for (const token of tokens) {
      if (text.includes(token)) {
        overlap += 1;
      }
    }
    const primaryBoost = looksLikePrimarySource(hit.url) ? 2 : 0;
    const score = overlap + primaryBoost;
    return { hit, score, index };
  });
  scored.sort((a, b) => {
    if (a.score === b.score) {
      return a.index - b.index;
    }
    return b.score - a.score;
  });
  return scored.map((item) => item.hit);
}

function buildAgenticRankingPrompt(goal: string, hits: SearchHit[]): string {
  const evidence = hits
    .map((hit, index) => `${index + 1}. ${hit.title} | ${hit.url} | ${hit.snippet} | provider=${hit.provider}`)
    .join("\n");
  return [
    "You are Alfred's ranking engine.",
    "Task: rank options for the user's goal using evidence.",
    "",
    "Return STRICT JSON only:",
    '{"confidence":"low|medium|high","topPick":"",\"summary\":\"\",\"ambiguityReasons\":[],\"followUpQuestions\":[],\"candidates\":[{\"name\":\"\",\"category\":\"\",\"score\":0,\"pros\":[],\"cons\":[],\"rationale\":\"\",\"evidenceUrls\":[]}]}',
    "",
    "Rules:",
    "- Recommend entities/tools/models, never links.",
    "- Use evidenceUrls from provided sources.",
    "- Set ambiguityReasons and followUpQuestions only when user constraints are missing.",
    "- Keep scores between 0 and 100.",
    "",
    `Goal: ${goal}`,
    "Evidence:",
    evidence
  ].join("\n");
}

function buildRankingRepairPrompt(goal: string, rawRanking: string): string {
  return [
    "You are repairing malformed JSON ranking output.",
    "Return STRICT JSON only with this shape:",
    '{"confidence":"low|medium|high","topPick":"",\"summary\":\"\",\"ambiguityReasons\":[],\"followUpQuestions\":[],\"candidates\":[{\"name\":\"\",\"category\":\"\",\"score\":0,\"pros\":[],\"cons\":[],\"rationale\":\"\",\"evidenceUrls\":[]}]}',
    "",
    "Requirements:",
    "- topPick and candidate names must be entities/tools/models, never URLs.",
    "- Keep only evidence URLs in evidenceUrls.",
    `Goal: ${goal}`,
    "",
    "Malformed or mixed output to repair:",
    rawRanking
  ].join("\n");
}

function buildAgenticSynthesisPrompt(
  goal: string,
  ranking: RankingResult,
  hits: SearchHit[],
  providersUsed: ResolvedProvider[]
): string {
  const evidence = hits
    .slice(0, 10)
    .map((hit, index) => `${index + 1}. ${hit.title} (${hit.url}) — ${hit.snippet}`)
    .join("\n");
  return [
    "You are Alfred, writing the final recommendation.",
    "Use ranking output and evidence. Do not invent facts.",
    "Output format:",
    "1) Recommendation (single best option)",
    "2) Why this option (3-5 bullets)",
    "3) Alternatives (2 options with tradeoffs)",
    "4) Confidence and caveats",
    "5) Sources (URLs only)",
    "",
    `Goal: ${goal}`,
    `Providers used: ${providersUsed.join(", ")}`,
    "",
    "Ranking JSON:",
    JSON.stringify(ranking, null, 2),
    "",
    "Evidence snippets:",
    evidence
  ].join("\n");
}

function buildConciseSynthesisPrompt(goal: string, ranking: RankingResult, hits: SearchHit[]): string {
  const evidence = hits
    .slice(0, 8)
    .map((hit, index) => `${index + 1}. ${hit.title} (${hit.url})`)
    .join("\n");
  return [
    "You are Alfred. Produce a concise recommendation.",
    "Output exactly:",
    "1) Best option",
    "2) Why (3 bullets)",
    "3) Alternatives (2 items)",
    "4) Confidence",
    "5) Sources (URLs)",
    "",
    `Goal: ${goal}`,
    "Ranking JSON:",
    JSON.stringify(ranking, null, 2),
    "",
    "Evidence:",
    evidence
  ].join("\n");
}

function parseRankingResult(raw: string): RankingResult | null {
  const parsed = parseJsonObjectFromText(raw);
  if (!parsed) {
    return null;
  }
  const confidenceRaw = String(parsed.confidence ?? "low").trim().toLowerCase();
  const confidence = confidenceRaw === "high" || confidenceRaw === "medium" ? confidenceRaw : "low";
  const topPick = String(parsed.topPick ?? "").trim();
  const summary = String(parsed.summary ?? "").trim();
  const ambiguityReasons = Array.isArray(parsed.ambiguityReasons)
    ? parsed.ambiguityReasons.map((item) => String(item ?? "").trim()).filter((item) => item.length > 0)
    : [];
  const followUpQuestions = Array.isArray(parsed.followUpQuestions)
    ? parsed.followUpQuestions.map((item) => String(item ?? "").trim()).filter((item) => item.length > 0).slice(0, 2)
    : [];
  const rawCandidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
  const candidates: RankingCandidate[] = rawCandidates
    .map((candidate) => {
      if (!candidate || typeof candidate !== "object") {
        return null;
      }
      const record = candidate as Record<string, unknown>;
      const name = sanitizeCandidateName(String(record.name ?? "").trim());
      if (!name) {
        return null;
      }
      const scoreRaw = Number(record.score);
      const score = Number.isFinite(scoreRaw) ? Math.max(0, Math.min(100, Math.round(scoreRaw))) : 0;
      const category = String(record.category ?? "option").trim() || "option";
      const pros = Array.isArray(record.pros)
        ? record.pros.map((item) => String(item ?? "").trim()).filter((item) => item.length > 0).slice(0, 4)
        : [];
      const cons = Array.isArray(record.cons)
        ? record.cons.map((item) => String(item ?? "").trim()).filter((item) => item.length > 0).slice(0, 4)
        : [];
      const evidenceUrls = Array.isArray(record.evidenceUrls)
        ? record.evidenceUrls
            .map((item) => String(item ?? "").trim())
            .filter((item) => /^https?:\/\//i.test(item))
            .slice(0, 5)
        : [];
      return {
        name,
        category,
        score,
        pros,
        cons,
        rationale: String(record.rationale ?? "").trim(),
        evidenceUrls
      };
    })
    .filter((item): item is RankingCandidate => item !== null);

  if (candidates.length === 0) {
    return null;
  }
  return {
    confidence,
    topPick: sanitizeTopPick(topPick || candidates[0]?.name || "", candidates),
    candidates,
    ambiguityReasons,
    followUpQuestions,
    summary
  };
}

function parseJsonObjectFromText(raw: string): Record<string, unknown> | null {
  const text = String(raw ?? "").trim();
  if (!text) {
    return null;
  }
  try {
    const direct = JSON.parse(text) as unknown;
    if (direct && typeof direct === "object" && !Array.isArray(direct)) {
      return direct as Record<string, unknown>;
    }
  } catch {
    // fallback extraction below
  }
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first < 0 || last <= first) {
    return null;
  }
  try {
    const extracted = JSON.parse(text.slice(first, last + 1)) as unknown;
    if (extracted && typeof extracted === "object" && !Array.isArray(extracted)) {
      return extracted as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function resolvePrimaryProvider(requested: SearchProvider): ResolvedProvider {
  if (requested === "auto") {
    return "searxng";
  }
  return requested;
}

function resolveFallbackProviders(primary: ResolvedProvider): ResolvedProvider[] {
  const all: ResolvedProvider[] = ["openai", "brave", "perplexity", "brightdata", "searxng"];
  return all.filter((provider) => provider !== primary);
}

function evaluateCoverage(hits: SearchHit[]): {
  hitCount: number;
  distinctDomainCount: number;
  hasPrimarySource: boolean;
  weakCoverage: boolean;
} {
  const hitCount = hits.length;
  const distinctDomainCount = countDistinctDomains(hits);
  const hasPrimarySource = hits.some((hit) => looksLikePrimarySource(hit.url));
  const weakCoverage = hitCount < 4 || distinctDomainCount < 3;
  return {
    hitCount,
    distinctDomainCount,
    hasPrimarySource,
    weakCoverage
  };
}

function evaluateRecommendationQuality(
  hits: SearchHit[],
  ranking: RankingResult
): { passed: boolean; reasons: string[] } {
  const coverage = evaluateCoverage(hits);
  const reasons: string[] = [];
  if (coverage.hitCount < 3) {
    reasons.push("fewer_than_3_sources");
  }
  if (coverage.distinctDomainCount < 3) {
    reasons.push("insufficient_domain_diversity");
  }
  if (!ranking.topPick.trim()) {
    reasons.push("missing_top_pick");
  }
  if (looksLikeUrl(ranking.topPick)) {
    reasons.push("top_pick_is_url");
  }
  if (looksLikeSourceTitle(ranking.topPick, hits)) {
    reasons.push("top_pick_is_source_title");
  }
  if (ranking.candidates.length < 2) {
    reasons.push("insufficient_ranked_candidates");
  }
  return {
    passed: reasons.length === 0,
    reasons
  };
}

function renderNoRankingFallback(goal: string, hits: SearchHit[], providersUsed: ResolvedProvider[]): string {
  const shortlist = hits.slice(0, 5);
  if (shortlist.length === 0) {
    return [
      "I gathered context but could not complete ranking reliably.",
      `Goal: ${goal}`,
      "I need one clarification: what's your top priority (cost, quality, speed, or flexibility)?"
    ].join("\n");
  }
  return [
    "I collected sources but couldn't complete reliable ranking within budget.",
    `Goal: ${goal}`,
    `Providers used: ${providersUsed.join(", ")}`,
    "",
    "Strongest collected options so far:",
    shortlist.map((item, index) => `${index + 1}. ${extractOptionName(item.title)} — ${item.url}`).join("\n"),
    "",
    "If you share your top priority (cost, quality, speed, or ecosystem), I can finalize a recommendation."
  ].join("\n");
}

function renderClarificationRequest(goal: string, ranking: RankingResult): string {
  const questions = ranking.followUpQuestions.slice(0, 2);
  return [
    "Before I recommend one option, I need two quick clarifications:",
    ...questions.map((item, index) => `${index + 1}. ${item}`),
    "",
    `Goal: ${goal}`
  ].join("\n");
}

function renderQualityGateFallback(
  goal: string,
  ranking: RankingResult,
  hits: SearchHit[],
  quality: { passed: boolean; reasons: string[] }
): string {
  const top = ranking.candidates.slice(0, 3);
  const sources = hits.slice(0, 4).map((item) => `- ${item.url}`).join("\n");
  return [
    "I can give you a provisional shortlist, but confidence is not high enough for a final recommendation yet.",
    `Why: ${quality.reasons.join(", ")}`,
    "",
    "Current top options (needs one more pass before hard recommendation):",
    ...top.map((item, index) => `${index + 1}. ${item.name} (score ${item.score})`),
    "",
    "Top sources:",
    sources || "- none",
    "",
    "If you share one priority (cost, quality, speed, or ecosystem), I can finalize the recommendation."
  ].join("\n");
}

function renderRankOnlyRecommendation(
  goal: string,
  ranking: RankingResult,
  hits: SearchHit[],
  providersUsed: ResolvedProvider[]
): string {
  const top = ranking.candidates[0];
  const alternatives = ranking.candidates.slice(1, 3);
  const sourceUrls = Array.from(new Set(hits.map((item) => item.url))).slice(0, 6);
  const bestOption = sanitizeTopPick(top?.name || ranking.topPick, ranking.candidates) || "Top-ranked option";
  return [
    `Recommendation: ${bestOption}`,
    "",
    `Why this pick: ${top?.rationale || ranking.summary || "Best overall tradeoff from current evidence."}`,
    "",
    "Alternatives:",
    ...alternatives.map((item, index) => `${index + 1}. ${item.name} (score ${item.score})`),
    "",
    `Confidence: ${ranking.confidence}`,
    `Providers used: ${providersUsed.join(", ")}`,
    `Goal: ${goal}`,
    "",
    "Sources:",
    ...sourceUrls.map((url) => `- ${url}`)
  ].join("\n");
}

function mergeSearchHits(primary: SearchHit[], fallback: SearchHit[], limit: number): SearchHit[] {
  const seen = new Set<string>();
  const merged: SearchHit[] = [];
  for (const hit of [...primary, ...fallback]) {
    const key = hit.url.toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(hit);
    if (merged.length >= limit) {
      break;
    }
  }
  return merged;
}

function buildHeuristicRanking(goal: string, hits: SearchHit[]): RankingResult | null {
  if (hits.length === 0) {
    return null;
  }
  const candidates = hits
    .slice(0, 6)
    .map((hit, index): RankingCandidate | null => {
      const name = extractOptionName(hit.title);
      if (!name || looksLikeUrl(name)) {
        return null;
      }
      const score = Math.max(40, 90 - index * 7 + (looksLikePrimarySource(hit.url) ? 4 : 0));
      return {
        name,
        category: "option",
        score,
        pros: [hit.snippet || "Strong relevance to the goal"],
        cons: [] as string[],
        rationale: `Derived from retrieved evidence (${hit.domain}).`,
        evidenceUrls: [hit.url]
      };
    })
    .filter((item): item is RankingCandidate => item !== null);
  if (candidates.length === 0) {
    return null;
  }
  return {
    confidence: candidates.length >= 3 ? "medium" : "low",
    topPick: candidates[0]!.name,
    candidates,
    ambiguityReasons: [],
    followUpQuestions: [],
    summary: `Heuristic ranking generated from ${Math.min(6, hits.length)} evidence hits for: ${goal}`
  };
}

function compactSearchHitsForSynthesis(hits: SearchHit[], limit: number): SearchHit[] {
  return hits.slice(0, limit).map((hit) => ({
    ...hit,
    snippet: hit.snippet.length > 220 ? `${hit.snippet.slice(0, 217)}...` : hit.snippet
  }));
}

function countDistinctDomains(hits: SearchHit[]): number {
  return new Set(hits.map((hit) => hit.domain).filter((item) => item.length > 0)).size;
}

function looksLikePrimarySource(url: string): boolean {
  const host = safeDomain(url);
  if (!host) {
    return false;
  }
  if (host.includes("docs.")) {
    return true;
  }
  if (host.endsWith(".gov") || host.endsWith(".edu")) {
    return true;
  }
  const knownPrimary = ["openai.com", "anthropic.com", "google.com", "microsoft.com", "github.com", "redis.io"];
  return knownPrimary.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function extractSearchHits(searchText: string, limit: number, provider: ResolvedProvider): SearchHit[] {
  const lines = searchText.split("\n");
  const hits: SearchHit[] = [];
  for (const rawLine of lines) {
    if (hits.length >= limit) {
      break;
    }
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const urlMatch = line.match(/https?:\/\/\S+/i);
    if (!urlMatch) {
      continue;
    }
    const url = urlMatch[0].replace(/[),.;]+$/, "").trim();
    const domain = safeDomain(url);
    if (!domain) {
      continue;
    }

    let title = line;
    let snippet = "";
    const formatted = line.match(/^\d+\.\s+(.+?)\s+-\s+(https?:\/\/\S+?)(?:\s+\|\s+(.+?))?(?:\s+\[engines:.*\])?$/i);
    if (formatted) {
      title = formatted[1]?.trim() || title;
      snippet = (formatted[3] ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
    } else {
      title = line
        .replace(/^\d+\.\s*/, "")
        .replace(/\s*https?:\/\/\S+.*$/i, "")
        .replace(/\s+\|.*/, "")
        .trim();
      const afterUrl = line.slice(line.indexOf(url) + url.length).replace(/^\s*[-|–—:]\s*/, "").trim();
      snippet = afterUrl.replace(/\s+/g, " ").slice(0, 240);
    }
    if (!title) {
      title = domain;
    }
    hits.push({
      title,
      url,
      snippet,
      provider,
      domain
    });
  }
  return hits;
}

function safeDomain(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

async function finalizePagedAgenticResponse(input: {
  sessionId: string;
  fullText: string;
  pagedResponseStore: {
    setPages: (sessionId: string, pages: string[]) => Promise<void>;
    clear: (sessionId: string) => Promise<void>;
  };
  summary: string;
  providersUsed: ResolvedProvider[];
  retriesUsed: number;
  tokenBudget: number;
  confidence: "low" | "medium" | "high";
  recommendationMode: "rank_only" | "rank_plus_synthesis";
  sourceStats?: { hits: number; distinctDomains: number };
  elapsedSec?: number;
}) {
  const pages = paginateResponse(input.fullText, 2800, 4);
  const firstPage = pages[0] ?? input.fullText;
  if (input.sessionId && pages.length > 1) {
    await input.pagedResponseStore.setPages(input.sessionId, pages.slice(1));
  } else if (input.sessionId) {
    await input.pagedResponseStore.clear(input.sessionId);
  }
  const responseText = pages.length > 1 ? `${firstPage}\n\nReply #next for more (${pages.length - 1} remaining).` : firstPage;
  return {
    summary: input.summary,
    responseText,
    mode: "agentic_turn",
    pageCount: pages.length,
    providersUsed: input.providersUsed,
    retriesUsed: Math.max(0, input.retriesUsed),
    tokenBudget: input.tokenBudget,
    confidence: input.confidence,
    recommendationMode: input.recommendationMode,
    sourceStats: input.sourceStats,
    elapsedSec: input.elapsedSec
  };
}

function extractOptionName(title: string): string {
  const cleaned = title
    .replace(/^[\d.\s-]+/, "")
    .replace(/\s*\|\s*.*/, "")
    .replace(/\s*-\s*https?:\/\/\S+$/i, "")
    .replace(/\s*\((https?:\/\/[^)]+)\)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) {
    return "";
  }
  const short = cleaned.split(":")[0]?.trim() || cleaned;
  return short.slice(0, 120);
}

function sanitizeTopPick(value: string, candidates: RankingCandidate[]): string {
  const cleaned = value.trim();
  if (!cleaned || looksLikeUrl(cleaned)) {
    return candidates[0]?.name ?? "";
  }
  const matched = candidates.find((item) => item.name.toLowerCase() === cleaned.toLowerCase());
  if (matched) {
    return matched.name;
  }
  return cleaned.slice(0, 120);
}

function sanitizeCandidateName(value: string): string {
  const cleaned = value
    .replace(/\s+/g, " ")
    .replace(/^\d+\.\s*/, "")
    .trim();
  if (!cleaned || looksLikeUrl(cleaned)) {
    return "";
  }
  return cleaned.slice(0, 120);
}

function looksLikeUrl(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return false;
  }
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return true;
  }
  return /^[a-z0-9.-]+\.[a-z]{2,}(?:\/|$)/i.test(trimmed);
}

function looksLikeSourceTitle(value: string, hits: SearchHit[]): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  const wordCount = normalized.split(/\s+/).filter((item) => item.length > 0).length;
  if (wordCount <= 4) {
    return false;
  }
  return hits.some((hit) => {
    const title = hit.title.trim().toLowerCase();
    return title === normalized || normalized.includes(title);
  });
}

function buildLegacyWebToFileRunSpec(input: {
  runId: string;
  query: string;
  provider: SearchProvider;
  fileFormat: AttachmentFormat;
  fileName?: string;
  sessionId?: string;
}): RunSpecV1 {
  const safeFileName = buildAttachmentFileName(input.fileName, input.query, input.fileFormat);
  return {
    version: 1,
    id: `legacy-${input.runId}`,
    goal: `Research and send attachment for query: ${input.query}`,
    metadata: {
      migratedFrom: "web_to_file"
    },
    steps: [
      {
        id: "search",
        type: "web.search",
        name: "Web Search",
        input: {
          query: input.query,
          provider: input.provider
        }
      },
      {
        id: "compose",
        type: "doc.compose",
        name: "Compose Document",
        input: {
          query: input.query,
          fileFormat: input.fileFormat
        }
      },
      {
        id: "write",
        type: "file.write",
        name: "Write File",
        input: {
          fileFormat: input.fileFormat,
          fileName: safeFileName
        }
      },
      {
        id: "send",
        type: "channel.send_attachment",
        name: "Send Attachment",
        input: {
          sessionId: input.sessionId,
          caption: `Research doc: ${input.query.slice(0, 80)}`
        }
      }
    ]
  };
}

function buildAttachmentFileName(raw: unknown, query: string, fileFormat: AttachmentFormat): string {
  if (typeof raw === "string" && raw.trim()) {
    const sanitized = raw
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 80);
    if (sanitized) {
      return ensureExtension(sanitized, fileFormat);
    }
  }

  const slug = query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  const day = new Date().toISOString().slice(0, 10);
  const base = slug || "research";
  return `${base}_${day}.${fileFormat}`;
}

function ensureExtension(fileName: string, ext: AttachmentFormat): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(`.${ext}`)) {
    return fileName;
  }
  return `${fileName}.${ext}`;
}

function paginateResponse(text: string, maxCharsPerPage: number, maxPages: number): string[] {
  const compact = text.trim();
  if (!compact) {
    return [];
  }
  if (compact.length <= maxCharsPerPage) {
    return [compact];
  }

  const paragraphs = compact
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  const pages: string[] = [];
  let current = "";

  const pushCurrent = () => {
    const value = current.trim();
    if (!value) {
      return;
    }
    pages.push(value);
    current = "";
  };

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= maxCharsPerPage) {
      current = candidate;
      continue;
    }

    pushCurrent();
    if (paragraph.length <= maxCharsPerPage) {
      current = paragraph;
      continue;
    }

    const chunks = paragraph.match(new RegExp(`.{1,${maxCharsPerPage}}`, "g")) ?? [paragraph];
    for (const chunk of chunks) {
      pages.push(chunk.trim());
      if (pages.length >= maxPages) {
        return pages;
      }
    }
  }

  pushCurrent();
  if (pages.length === 0) {
    return [compact.slice(0, maxCharsPerPage)];
  }
  return pages.slice(0, maxPages);
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof raw === "number" ? raw : Number.NaN;
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  const value = Math.floor(numeric);
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

function msRemaining(deadlineAt: number, floorMs: number): number {
  return Math.max(floorMs, deadlineAt - Date.now());
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(message));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

async function withProgressPulse<T>(
  runner: () => Promise<T>,
  options: {
    intervalMs: number;
    onPulse: (elapsedMs: number) => Promise<void>;
  }
): Promise<T> {
  const startedAt = Date.now();
  let timer: NodeJS.Timeout | null = null;
  try {
    timer = setInterval(() => {
      void options.onPulse(Date.now() - startedAt);
    }, Math.max(1000, options.intervalMs));
    return await runner();
  } finally {
    if (timer) {
      clearInterval(timer);
    }
  }
}
