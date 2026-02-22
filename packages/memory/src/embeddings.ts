import { createHash } from "node:crypto";
import type { EmbeddingProvider } from "./types";

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly provider = "openai";

  constructor(
    private readonly apiKey: string,
    readonly model = "text-embedding-3-small"
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.model,
        input: texts
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI embeddings request failed: ${response.status}`);
    }

    const json = (await response.json()) as {
      data: Array<{ embedding: number[] }>;
    };

    return json.data.map((entry) => entry.embedding);
  }
}

export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  readonly provider = "deterministic";
  readonly model = "hash-v1";

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const hash = createHash("sha256").update(text).digest();
      const vector: number[] = [];
      for (let i = 0; i < 32; i += 2) {
        const value = ((hash[i] << 8) | hash[i + 1]) / 65535;
        vector.push(value * 2 - 1);
      }
      return vector;
    });
  }
}

export function createDefaultEmbeddingProvider(env: Record<string, string | undefined>): EmbeddingProvider | null {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    return null;
  }

  const model = env.MEMORY_EMBEDDING_MODEL ?? "text-embedding-3-small";
  return new OpenAIEmbeddingProvider(apiKey, model);
}
