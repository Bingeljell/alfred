import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { IntentPlanner } from "../../apps/gateway-orchestrator/src/builtins/intent_planner";
import { SystemPromptCatalog } from "../../apps/gateway-orchestrator/src/builtins/system_prompt_catalog";

describe("IntentPlanner", () => {
  it("returns command intent for slash commands without calling llm", async () => {
    const llm = {
      generateText: vi.fn()
    };
    const catalog = new SystemPromptCatalog(process.cwd(), []);
    const planner = new IntentPlanner({
      llmService: llm as never,
      systemPromptCatalog: catalog
    });

    const result = await planner.plan("s1", "/task list");
    expect(result.intent).toBe("command");
    expect(llm.generateText).toHaveBeenCalledTimes(0);
  });

  it("uses llm json decision when available", async () => {
    const llm = {
      generateText: vi.fn().mockResolvedValue({
        text: '{"intent":"web_research","confidence":0.92,"needsWorker":true,"query":"best stable diffusion models","provider":"searxng","sendAttachment":true,"fileFormat":"md","fileName":"stable_diffusion_report","reason":"research_task"}'
      })
    };
    const catalog = new SystemPromptCatalog(process.cwd(), []);
    const planner = new IntentPlanner({
      llmService: llm as never,
      systemPromptCatalog: catalog
    });

    const result = await planner.plan("s1", "research best stable diffusion models");
    expect(result.intent).toBe("web_research");
    expect(result.needsWorker).toBe(true);
    expect(result.provider).toBe("searxng");
    expect(result.query).toBe("best stable diffusion models");
    expect(result.sendAttachment).toBe(true);
    expect(result.fileFormat).toBe("md");
    expect(result.fileName).toBe("stable_diffusion_report");
  });

  it("enforces worker delegation policy for web_research and attachment outputs", async () => {
    const llm = {
      generateText: vi
        .fn()
        .mockResolvedValueOnce({
          text: '{"intent":"web_research","confidence":0.92,"needsWorker":false,"query":"latest middle east updates","reason":"research_task"}'
        })
        .mockResolvedValueOnce({
          text: '{"intent":"command","confidence":0.88,"needsWorker":false,"query":"prepare and send summary","sendAttachment":true,"fileFormat":"md","reason":"attachment_task"}'
        })
    };
    const catalog = new SystemPromptCatalog(process.cwd(), []);
    const planner = new IntentPlanner({
      llmService: llm as never,
      systemPromptCatalog: catalog
    });

    const webResearch = await planner.plan("s1", "search latest middle east updates");
    expect(webResearch.intent).toBe("web_research");
    expect(webResearch.needsWorker).toBe(true);

    const attachment = await planner.plan("s1", "create and send summary doc");
    expect(attachment.intent).toBe("command");
    expect(attachment.sendAttachment).toBe(true);
    expect(attachment.needsWorker).toBe(true);
  });

  it("falls back to heuristic when llm output is invalid json", async () => {
    const llm = {
      generateText: vi.fn().mockResolvedValue({
        text: "I think this is probably a research request"
      })
    };
    const catalog = new SystemPromptCatalog(process.cwd(), []);
    const planner = new IntentPlanner({
      llmService: llm as never,
      systemPromptCatalog: catalog
    });

    const result = await planner.plan("s1", "research and compare top local llm models");
    expect(result.intent).toBe("web_research");
    expect(result.needsWorker).toBe(true);
    expect(result.reason).toContain("heuristic");
  });

  it("detects attachment intent heuristically for research send-doc asks", async () => {
    const catalog = new SystemPromptCatalog(process.cwd(), []);
    const planner = new IntentPlanner({
      systemPromptCatalog: catalog,
      enabled: false
    });

    const result = await planner.plan("s1", "research best SD models and send me a markdown doc");
    expect(result.intent).toBe("web_research");
    expect(result.sendAttachment).toBe(true);
    expect(result.fileFormat).toBe("md");
    expect(result.needsWorker).toBe(true);
  });

  it("loads system prompt docs from configured files", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-prompt-catalog-unit-"));
    const docsDir = path.join(rootDir, "docs");
    await fs.mkdir(docsDir, { recursive: true });
    await fs.writeFile(path.join(docsDir, "a.md"), "alpha", "utf8");
    await fs.writeFile(path.join(docsDir, "b.md"), "beta", "utf8");

    const catalog = new SystemPromptCatalog(rootDir, ["docs/a.md", "docs/b.md"]);
    const prompt = await catalog.load();
    expect(prompt).toContain("docs/a.md");
    expect(prompt).toContain("alpha");
    expect(prompt).toContain("docs/b.md");
    expect(prompt).toContain("beta");
  });
});
