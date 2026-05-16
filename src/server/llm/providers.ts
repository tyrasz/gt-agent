import { sitrepResponseSchema, type Provider, type SitrepResponse } from "../../shared/schemas.js";
import type { GameSnapshot, PlayerPlanningContext } from "../../shared/schemas.js";

export type StructuredPlanInput = {
  provider: Provider;
  model: string;
  providerApiKey: string;
  planningContext: PlayerPlanningContext;
  snapshot: GameSnapshot;
  deterministicSitrep: SitrepResponse;
};

export type LlmPlanner = {
  generateStructuredPlan(input: StructuredPlanInput): Promise<SitrepResponse>;
};

export type LlmPlannerOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

const DEFAULT_LLM_TIMEOUT_MS = 30_000;

export class LlmProviderError extends Error {
  constructor(message: string, readonly provider: Provider, readonly status?: number) {
    super(message);
    this.name = "LlmProviderError";
  }
}

export class RestLlmPlanner implements LlmPlanner {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: LlmPlannerOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? Number(process.env.LLM_TIMEOUT_MS ?? DEFAULT_LLM_TIMEOUT_MS);
  }

  async generateStructuredPlan(input: StructuredPlanInput): Promise<SitrepResponse> {
    let validationHint = "";
    let lastValidationError = "";

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const prompt = buildPrompt(input, validationHint);
      let text: string;
      let parsedJson: unknown;

      try {
        text = await this.callProvider(input, prompt);
        parsedJson = parseJsonObject(text);
      } catch (error) {
        if (error instanceof LlmProviderError) throw error;
        lastValidationError = error instanceof Error ? error.message : "Provider response could not be parsed.";
        validationHint = `The previous response could not be parsed as JSON: ${lastValidationError}`;
        continue;
      }

      const parsed = sitrepResponseSchema.safeParse(parsedJson);
      if (parsed.success) {
        return {
          ...parsed.data,
          provider: input.provider,
          model: input.model,
          rawSnapshot: input.snapshot,
          warnings: [...input.deterministicSitrep.warnings, ...parsed.data.warnings]
        };
      }
      lastValidationError = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
      validationHint = `The previous JSON failed validation: ${lastValidationError}`;
    }

    throw new LlmProviderError(`Provider returned JSON that did not match the sitrep schema.${lastValidationError ? ` ${lastValidationError}` : ""}`, input.provider);
  }

  private async callProvider(input: StructuredPlanInput, prompt: string): Promise<string> {
    if (input.provider === "openai") return this.callOpenAi(input, prompt);
    if (input.provider === "anthropic") return this.callAnthropic(input, prompt);
    return this.callGemini(input, prompt);
  }

  private async callOpenAi(input: StructuredPlanInput, prompt: string): Promise<string> {
    const response = await this.fetchProvider(input.provider, "https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.providerApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: input.model,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt() },
          { role: "user", content: prompt }
        ]
      })
    });

    const body = await parseProviderResponse(response, input.provider);
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new LlmProviderError("OpenAI response did not include message content.", input.provider, response.status);
    return content;
  }

  private async callAnthropic(input: StructuredPlanInput, prompt: string): Promise<string> {
    const response = await this.fetchProvider(input.provider, "https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": input.providerApiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: input.model,
        max_tokens: 6000,
        system: systemPrompt(),
        messages: [{ role: "user", content: prompt }]
      })
    });

    const body = await parseProviderResponse(response, input.provider);
    const text = body.content?.find((part: unknown) => isRecord(part) && part.type === "text")?.text;
    if (typeof text !== "string") throw new LlmProviderError("Anthropic response did not include text content.", input.provider, response.status);
    return text;
  }

  private async callGemini(input: StructuredPlanInput, prompt: string): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.model)}:generateContent?key=${encodeURIComponent(input.providerApiKey)}`;
    const response = await this.fetchProvider(input.provider, url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: `${systemPrompt()}\n\n${prompt}` }] }],
        generationConfig: {
          responseMimeType: "application/json"
        }
      })
    });

    const body = await parseProviderResponse(response, input.provider);
    const text = body.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text ?? "").join("");
    if (typeof text !== "string" || text.length === 0) throw new LlmProviderError("Gemini response did not include text content.", input.provider, response.status);
    return text;
  }

  private async fetchProvider(provider: Provider, url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (isAbortError(error)) {
        throw new LlmProviderError(`${provider} request timed out after ${Math.round(this.timeoutMs / 1000)}s.`, provider);
      }
      throw new LlmProviderError(error instanceof Error ? error.message : `${provider} request failed.`, provider);
    } finally {
      clearTimeout(timeout);
    }
  }
}

function systemPrompt(): string {
  return [
    "You are GT Agent, a read-only Galactic Tycoons operations analyst.",
    "Use only the provided snapshot and deterministic analysis.",
    "Recommend manual actions and prepared checklists. Do not claim actions were executed.",
    "Return one valid JSON object matching the requested shape. No markdown."
  ].join(" ");
}

function buildPrompt(input: StructuredPlanInput, validationHint: string): string {
  const compact = {
    planningContext: input.planningContext,
    snapshotSummary: summarizeSnapshot(input.snapshot),
    deterministicSitrep: {
      summary: input.deterministicSitrep.summary,
      actionPlans: input.deterministicSitrep.actionPlans,
      marketSignals: input.deterministicSitrep.marketSignals,
      stockoutRisks: input.deterministicSitrep.stockoutRisks,
      expansionCandidates: input.deterministicSitrep.expansionCandidates,
      logisticsMoves: input.deterministicSitrep.logisticsMoves,
      warnings: input.deterministicSitrep.warnings
    }
  };

  return [
    validationHint,
    "Create the final SitrepResponse JSON with these top-level keys:",
    "generatedAt, provider, model, summary, actionPlans, marketSignals, stockoutRisks, expansionCandidates, logisticsMoves, warnings.",
    "preparedCommands must always include executable:false.",
    "Keep rawSnapshot out of your JSON; the server will attach it.",
    JSON.stringify(compact)
  ].filter(Boolean).join("\n\n");
}

function summarizeSnapshot(snapshot: GameSnapshot) {
  return {
    fetchedAt: snapshot.fetchedAt,
    company: {
      id: snapshot.company.id,
      name: snapshot.company.name,
      cash: snapshot.company.cash,
      rank: snapshot.company.rank,
      value: snapshot.company.value,
      poSlots: snapshot.company.poSlots,
      shipSlots: snapshot.company.shipSlots
    },
    counts: {
      bases: snapshot.bases.length,
      warehouses: snapshot.warehouses.length,
      exchangeOrders: snapshot.exchangeOrders.length,
      contracts: snapshot.contracts.length,
      basePlans: snapshot.basePlans.length,
      wishlists: snapshot.wishlists.length,
      marketMaterials: snapshot.market.details.length || snapshot.market.prices.length
    },
    bases: snapshot.bases.slice(0, 12).map((base) => ({
      id: base.id,
      name: base.name,
      planetId: base.planetId,
      warehouseId: base.warehouseId,
      buildingSlots: base.buildingSlots
    })),
    warnings: snapshot.warnings
  };
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("Provider response did not contain a JSON object.");
  }
}

async function parseProviderResponse(response: Response, provider: Provider): Promise<Record<string, any>> {
  const text = await response.text();
  let body: Record<string, any>;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: text };
  }

  if (!response.ok) {
    const message = body.error?.message ?? body.error ?? `${provider} returned ${response.status}.`;
    throw new LlmProviderError(String(message), provider, response.status);
  }

  return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
