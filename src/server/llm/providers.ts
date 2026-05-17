import { z } from "zod";
import { type Provider, type SitrepResponse } from "../../shared/schemas.js";
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
  timeoutMsByProvider?: Partial<Record<Provider, number>>;
  largeTimeoutMs?: number;
  largeTimeoutMsByProvider?: Partial<Record<Provider, number>>;
};

const DEFAULT_LLM_TIMEOUT_MS = 30_000;
const DEFAULT_OPENAI_TIMEOUT_MS = 60_000;
const DEFAULT_LARGE_MODEL_TIMEOUT_MS = 12 * 60_000;
const DEFAULT_PROVIDER_TIMEOUT_MS: Record<Provider, number> = {
  openai: DEFAULT_OPENAI_TIMEOUT_MS,
  anthropic: DEFAULT_LLM_TIMEOUT_MS,
  gemini: DEFAULT_LLM_TIMEOUT_MS
};

const llmPlanDraftSchema = z.object({
  summary: z.string().trim().min(1),
  actionPlanNarratives: z.array(z.object({
    id: z.string().trim().min(1),
    expectedBenefit: z.string().trim().optional(),
    risk: z.string().trim().optional(),
    whyNow: z.string().trim().optional(),
    evidence: z.array(z.string()).optional()
  })).default([]),
  warnings: z.array(z.string()).default([])
});

const llmPlanDraftJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: {
      type: "string",
      description: "A concise player-facing SITREP summary answering the current request first."
    },
    actionPlanNarratives: {
      type: "array",
      description: "Narrative updates for existing deterministic action ids only. Do not invent new ids or reorder actions.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          expectedBenefit: { type: "string" },
          risk: { type: "string" },
          whyNow: { type: "string" },
          evidence: { type: "array", items: { type: "string" } }
        },
        required: ["id"]
      }
    },
    warnings: {
      type: "array",
      description: "Provider-side caveats that should be shown to the player.",
      items: { type: "string" }
    }
  },
  required: ["summary", "actionPlanNarratives", "warnings"]
} as const;

export class LlmProviderError extends Error {
  constructor(message: string, readonly provider: Provider, readonly status?: number, readonly model?: string) {
    super(message);
    this.name = "LlmProviderError";
  }
}

export class LlmProviderTimeoutError extends LlmProviderError {
  constructor(provider: Provider, model: string, readonly timeoutMs: number) {
    super(`${providerLabel(provider)} did not respond within ${formatTimeout(timeoutMs)}. Try a faster model or another provider.`, provider, undefined, model);
    this.name = "LlmProviderTimeoutError";
  }
}

export class RestLlmPlanner implements LlmPlanner {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMsByProvider: Record<Provider, number>;
  private readonly largeTimeoutMsByProvider: Record<Provider, number>;

  constructor(options: LlmPlannerOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    const fallbackTimeoutMs = options.timeoutMs ?? numberEnv("LLM_TIMEOUT_MS");
    const fallbackLargeTimeoutMs = options.largeTimeoutMs ?? numberEnv("LLM_LARGE_MODEL_TIMEOUT_MS");
    this.timeoutMsByProvider = {
      openai: options.timeoutMsByProvider?.openai ?? numberEnv("OPENAI_TIMEOUT_MS") ?? fallbackTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS.openai,
      anthropic: options.timeoutMsByProvider?.anthropic ?? numberEnv("ANTHROPIC_TIMEOUT_MS") ?? fallbackTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS.anthropic,
      gemini: options.timeoutMsByProvider?.gemini ?? numberEnv("GEMINI_TIMEOUT_MS") ?? fallbackTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS.gemini
    };
    this.largeTimeoutMsByProvider = {
      openai: options.largeTimeoutMsByProvider?.openai ?? numberEnv("OPENAI_LARGE_MODEL_TIMEOUT_MS") ?? fallbackLargeTimeoutMs ?? DEFAULT_LARGE_MODEL_TIMEOUT_MS,
      anthropic: options.largeTimeoutMsByProvider?.anthropic ?? numberEnv("ANTHROPIC_LARGE_MODEL_TIMEOUT_MS") ?? fallbackLargeTimeoutMs ?? DEFAULT_LARGE_MODEL_TIMEOUT_MS,
      gemini: options.largeTimeoutMsByProvider?.gemini ?? numberEnv("GEMINI_LARGE_MODEL_TIMEOUT_MS") ?? fallbackLargeTimeoutMs ?? DEFAULT_LARGE_MODEL_TIMEOUT_MS
    };
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

      const parsed = llmPlanDraftSchema.safeParse(parsedJson);
      if (parsed.success) {
        const draft = parsed.data;
        return {
          ...input.deterministicSitrep,
          summary: draft.summary,
          actionPlans: mergeActionPlanNarratives(input.deterministicSitrep.actionPlans, draft.actionPlanNarratives),
          provider: input.provider,
          model: input.model,
          rawSnapshot: input.snapshot,
          warnings: mergeWarnings(input.deterministicSitrep.warnings, draft.warnings)
        };
      }
      lastValidationError = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
      validationHint = `The previous JSON failed validation: ${lastValidationError}`;
    }

    throw new LlmProviderError(`Provider returned JSON that did not match the LLM draft schema.${lastValidationError ? ` ${lastValidationError}` : ""}`, input.provider, undefined, input.model);
  }

  private async callProvider(input: StructuredPlanInput, prompt: string): Promise<string> {
    if (input.provider === "openai") return this.callOpenAi(input, prompt);
    if (input.provider === "anthropic") return this.callAnthropic(input, prompt);
    return this.callGemini(input, prompt);
  }

  private async callOpenAi(input: StructuredPlanInput, prompt: string): Promise<string> {
    const response = await this.fetchProvider(input.provider, input.model, "https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.providerApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: input.model,
        instructions: systemPrompt(),
        input: prompt,
        max_output_tokens: 6000,
        store: false,
        text: {
          format: {
            type: "json_schema",
            name: "gt_agent_plan_draft",
            schema: llmPlanDraftJsonSchema,
            strict: false
          }
        }
      })
    });

    const body = await parseProviderResponse(response, input.provider, input.model);
    const content = extractOpenAiResponseText(body);
    if (typeof content !== "string") throw new LlmProviderError("OpenAI response did not include message content.", input.provider, response.status, input.model);
    return content;
  }

  private async callAnthropic(input: StructuredPlanInput, prompt: string): Promise<string> {
    const response = await this.fetchProvider(input.provider, input.model, "https://api.anthropic.com/v1/messages", {
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

    const body = await parseProviderResponse(response, input.provider, input.model);
    const text = body.content?.find((part: unknown) => isRecord(part) && part.type === "text")?.text;
    if (typeof text !== "string") throw new LlmProviderError("Anthropic response did not include text content.", input.provider, response.status, input.model);
    return text;
  }

  private async callGemini(input: StructuredPlanInput, prompt: string): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.model)}:generateContent?key=${encodeURIComponent(input.providerApiKey)}`;
    const response = await this.fetchProvider(input.provider, input.model, url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: `${systemPrompt()}\n\n${prompt}` }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: llmPlanDraftJsonSchema
        }
      })
    });

    const body = await parseProviderResponse(response, input.provider, input.model);
    const text = body.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text ?? "").join("");
    if (typeof text !== "string" || text.length === 0) throw new LlmProviderError("Gemini response did not include text content.", input.provider, response.status, input.model);
    return text;
  }

  private async fetchProvider(provider: Provider, model: string, url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeoutMs = resolveProviderTimeoutMs(provider, model, this.timeoutMsByProvider, this.largeTimeoutMsByProvider);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (isAbortError(error)) {
        throw new LlmProviderTimeoutError(provider, model, timeoutMs);
      }
      throw new LlmProviderError(error instanceof Error ? error.message : `${provider} request failed.`, provider, undefined, model);
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function resolveProviderTimeoutMs(
  provider: Provider,
  model: string,
  timeoutMsByProvider: Record<Provider, number> = DEFAULT_PROVIDER_TIMEOUT_MS,
  largeTimeoutMsByProvider: Record<Provider, number> = {
    openai: DEFAULT_LARGE_MODEL_TIMEOUT_MS,
    anthropic: DEFAULT_LARGE_MODEL_TIMEOUT_MS,
    gemini: DEFAULT_LARGE_MODEL_TIMEOUT_MS
  }
): number {
  return isLargeModel(provider, model) ? largeTimeoutMsByProvider[provider] : timeoutMsByProvider[provider];
}

export function isLargeModel(_provider: Provider, model: string): boolean {
  const lower = model.trim().toLowerCase();
  if (!lower) return false;
  if (/(^|[-_.])(flash-lite|flash|mini|nano|haiku)($|[-_.])/.test(lower)) return false;
  return true;
}

function systemPrompt(): string {
  return [
    "You are GT Agent, a read-only Galactic Tycoons operations analyst.",
    "Use only the provided snapshot and deterministic analysis.",
    "Recommend manual actions and prepared checklists. Do not claim actions were executed.",
    "Return one valid JSON object matching the requested LLM draft shape. No markdown."
  ].join(" ");
}

function buildPrompt(input: StructuredPlanInput, validationHint: string): string {
  const compact = {
    planningContext: input.planningContext,
    snapshotSummary: summarizeSnapshot(input.snapshot),
    deterministicSitrep: {
      summary: input.deterministicSitrep.summary,
      counts: {
        actionPlans: input.deterministicSitrep.actionPlans.length,
        marketSignals: input.deterministicSitrep.marketSignals.length,
        stockoutRisks: input.deterministicSitrep.stockoutRisks.length,
        expansionCandidates: input.deterministicSitrep.expansionCandidates.length,
        logisticsMoves: input.deterministicSitrep.logisticsMoves.length
      },
      topActionPlans: input.deterministicSitrep.actionPlans.slice(0, 5).map(compactActionPlan),
      topMarketSignals: input.deterministicSitrep.marketSignals.slice(0, 8).map(compactMarketSignal),
      topStockoutRisks: input.deterministicSitrep.stockoutRisks.slice(0, 8).map(compactStockoutRisk),
      topExpansionCandidates: input.deterministicSitrep.expansionCandidates.slice(0, 6).map(compactExpansionCandidate),
      topLogisticsMoves: input.deterministicSitrep.logisticsMoves.slice(0, 6).map(compactLogisticsMove),
      situation: input.deterministicSitrep.situation,
      warnings: input.deterministicSitrep.warnings
    }
  };

  return [
    validationHint,
    input.planningContext.userPrompt ? `The player request to answer first: ${input.planningContext.userPrompt}` : "",
    "Create only an LlmPlanDraft JSON object with these top-level keys: summary, actionPlanNarratives, warnings.",
    "The deterministic strategy engine owns action ids, ranking, categories, scores, commands, and feasibility. Do not invent new action ids or reorder actions.",
    "For actionPlanNarratives, only reference ids present in topActionPlans and only improve expectedBenefit, risk, whyNow, or evidence wording.",
    "Do not return provider, model, generatedAt, rawSnapshot, marketSignals, stockoutRisks, expansionCandidates, logisticsMoves, score, scoreBreakdown, preparedCommands, priority, category, title, or costSummary.",
    "Use the situation, score breakdowns, and compact deterministic signals below to explain why the ranked plan is situationally valid.",
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

function compactActionPlan(plan: SitrepResponse["actionPlans"][number]) {
  return {
    id: plan.id,
    title: plan.title,
    priority: plan.priority,
    category: plan.category,
    score: plan.score,
    confidence: plan.confidence,
    whyNow: plan.whyNow,
    scoreBreakdown: plan.scoreBreakdown,
    expectedBenefit: plan.expectedBenefit,
    costSummary: plan.costSummary,
    risk: plan.risk,
    evidence: plan.evidence.slice(0, 4),
    preparedCommands: plan.preparedCommands.slice(0, 2).map((command) => ({
      type: command.type,
      title: command.title,
      executable: command.executable,
      steps: command.steps.slice(0, 5)
    }))
  };
}

function compactMarketSignal(signal: SitrepResponse["marketSignals"][number]) {
  return {
    matId: signal.matId,
    matName: signal.matName,
    currentPrice: signal.currentPrice,
    avgPrice: signal.avgPrice,
    spreadPct: signal.spreadPct,
    ownedQty: signal.ownedQty,
    neededQty: signal.neededQty,
    netNeedQty: signal.netNeedQty,
    daysMarketSupply: signal.daysMarketSupply,
    liquidityScore: signal.liquidityScore,
    trendConfidence: signal.trendConfidence,
    cashImpactPct: signal.cashImpactPct,
    trend: signal.trend,
    volatilityPct: signal.volatilityPct,
    recipeMarginPct: signal.recipeMarginPct,
    recommendation: signal.recommendation,
    rationale: signal.rationale.slice(0, 3)
  };
}

function compactStockoutRisk(risk: SitrepResponse["stockoutRisks"][number]) {
  return {
    matId: risk.matId,
    matName: risk.matName,
    availableQty: risk.availableQty,
    requiredQty: risk.requiredQty,
    shortageQty: risk.shortageQty,
    hoursUntilStockout: risk.hoursUntilStockout,
    severity: risk.severity,
    affectedBases: risk.affectedBases.slice(0, 5)
  };
}

function compactExpansionCandidate(candidate: SitrepResponse["expansionCandidates"][number]) {
  return {
    title: candidate.title,
    type: candidate.type,
    priority: candidate.priority,
    estimatedCost: candidate.estimatedCost,
    blockers: candidate.blockers.slice(0, 4),
    rationale: candidate.rationale.slice(0, 4)
  };
}

function compactLogisticsMove(move: SitrepResponse["logisticsMoves"][number]) {
  return {
    from: move.from,
    to: move.to,
    matId: move.matId,
    materialName: move.materialName,
    quantity: move.quantity,
    tonnes: move.tonnes,
    reason: move.reason,
    steps: move.steps.slice(0, 5)
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

function extractOpenAiResponseText(body: Record<string, any>): string | undefined {
  if (typeof body.output_text === "string" && body.output_text.trim()) return body.output_text;
  if (!Array.isArray(body.output)) return undefined;

  const text = body.output
    .flatMap((item: unknown) => isRecord(item) && Array.isArray(item.content) ? item.content : [])
    .map((part: unknown) => isRecord(part) && typeof part.text === "string" ? part.text : "")
    .join("");

  return text.trim() ? text : undefined;
}

function mergeWarnings(base: string[], draft: string[]): string[] {
  return [...new Set([...base, ...draft])];
}

function mergeActionPlanNarratives(
  plans: SitrepResponse["actionPlans"],
  narratives: Array<{ id: string; expectedBenefit?: string; risk?: string; whyNow?: string; evidence?: string[] }>
): SitrepResponse["actionPlans"] {
  const byId = new Map(narratives.map((narrative) => [narrative.id, narrative]));
  return plans.map((plan) => {
    const narrative = byId.get(plan.id);
    if (!narrative) return plan;
    return {
      ...plan,
      expectedBenefit: narrative.expectedBenefit || plan.expectedBenefit,
      risk: narrative.risk || plan.risk,
      whyNow: narrative.whyNow || plan.whyNow,
      evidence: narrative.evidence?.length ? [...new Set([...plan.evidence, ...narrative.evidence])].slice(0, 6) : plan.evidence
    };
  });
}

function numberEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function providerLabel(provider: Provider): string {
  if (provider === "openai") return "OpenAI";
  if (provider === "anthropic") return "Anthropic";
  return "Gemini";
}

export function formatTimeout(timeoutMs: number): string {
  if (timeoutMs >= 60_000 && timeoutMs % 60_000 === 0) return `${Math.round(timeoutMs / 60_000)}m`;
  return timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`;
}

async function parseProviderResponse(response: Response, provider: Provider, model: string): Promise<Record<string, any>> {
  const text = await response.text();
  let body: Record<string, any>;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: text };
  }

  if (!response.ok) {
    const message = body.error?.message ?? body.error ?? `${provider} returned ${response.status}.`;
    throw new LlmProviderError(String(message), provider, response.status, model);
  }

  return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
