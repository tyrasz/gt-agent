import { z } from "zod";
import { type Provider, type SitrepResponse } from "../../shared/schemas.js";
import type { GameSnapshot, PlayerPlanningContext } from "../../shared/schemas.js";
import { formatMoney, numberValue } from "../analysis/utils.js";

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
  maxTokensByProvider?: Partial<Record<Provider, number>>;
};

type LlmPayloadDiagnostics = {
  promptChars: number;
  requestBytes: number;
  outputTokenCap: number;
  roughInputTokens: number;
  payloadProfile: string;
};

type ProviderCallResult = {
  text: string;
  diagnostics: LlmPayloadDiagnostics;
};

const DEFAULT_LLM_TIMEOUT_MS = 30_000;
const DEFAULT_OPENAI_TIMEOUT_MS = 60_000;
const DEFAULT_LARGE_MODEL_TIMEOUT_MS = 12 * 60_000;
const DEFAULT_PROVIDER_TIMEOUT_MS: Record<Provider, number> = {
  openai: DEFAULT_OPENAI_TIMEOUT_MS,
  anthropic: DEFAULT_LLM_TIMEOUT_MS,
  gemini: DEFAULT_LLM_TIMEOUT_MS
};
const DEFAULT_PROVIDER_MAX_TOKENS: Record<Provider, number> = {
  openai: 2200,
  anthropic: 2200,
  gemini: 2200
};

const shortNarrativeSchema = z.string().trim().max(240);
const decisionNarrativeSchema = z.string().trim().max(300);

const llmPlanDraftSchema = z.object({
  summary: z.string().trim().min(1).max(900),
  decisionBriefNarrative: z.object({
    thesis: z.string().trim().max(900).optional(),
    recommendedPath: z.array(decisionNarrativeSchema).max(4).optional(),
    whyThisPath: z.array(decisionNarrativeSchema).max(4).optional(),
    alternatives: z.array(z.object({
      title: z.string().trim().min(1).max(160),
      pros: z.array(shortNarrativeSchema).max(2).optional(),
      cons: z.array(shortNarrativeSchema).max(2).optional(),
      chooseWhen: decisionNarrativeSchema.optional()
    })).max(3).optional(),
    constraints: z.array(decisionNarrativeSchema).max(4).optional(),
    inspectNext: z.array(decisionNarrativeSchema).max(4).optional()
  }).default({}),
  actionPlanNarratives: z.array(z.object({
    id: z.string().trim().min(1),
    expectedBenefit: shortNarrativeSchema.optional(),
    risk: shortNarrativeSchema.optional(),
    whyNow: shortNarrativeSchema.optional(),
    bestWhen: shortNarrativeSchema.optional(),
    avoidIf: shortNarrativeSchema.optional(),
    whatWouldChangeThis: shortNarrativeSchema.optional(),
    evidence: z.array(shortNarrativeSchema).max(2).optional()
  })).max(3).default([]),
  warnings: z.array(decisionNarrativeSchema).max(4).default([])
});

const llmPlanDraftJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: {
      type: "string",
      maxLength: 900,
      description: "A concise player-facing SITREP summary answering the current request first."
    },
    decisionBriefNarrative: {
      type: "object",
      description: "Narrative updates for the existing deterministic Decision Brief. Preserve the deterministic decision shape and do not invent unsupported options.",
      additionalProperties: false,
      properties: {
        thesis: { type: "string", maxLength: 900 },
        recommendedPath: { type: "array", maxItems: 4, items: { type: "string", maxLength: 300 } },
        whyThisPath: { type: "array", maxItems: 4, items: { type: "string", maxLength: 300 } },
        alternatives: {
          type: "array",
          maxItems: 3,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              title: { type: "string", maxLength: 160 },
              pros: { type: "array", maxItems: 2, items: { type: "string", maxLength: 240 } },
              cons: { type: "array", maxItems: 2, items: { type: "string", maxLength: 240 } },
              chooseWhen: { type: "string", maxLength: 300 }
            },
            required: ["title"]
          }
        },
        constraints: { type: "array", maxItems: 4, items: { type: "string", maxLength: 300 } },
        inspectNext: { type: "array", maxItems: 4, items: { type: "string", maxLength: 300 } }
      }
    },
    actionPlanNarratives: {
      type: "array",
      maxItems: 3,
      description: "Narrative updates for existing deterministic action ids only. Do not invent new ids or reorder actions.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          expectedBenefit: { type: "string", maxLength: 240 },
          risk: { type: "string", maxLength: 240 },
          whyNow: { type: "string", maxLength: 240 },
          bestWhen: { type: "string", maxLength: 240 },
          avoidIf: { type: "string", maxLength: 240 },
          whatWouldChangeThis: { type: "string", maxLength: 240 },
          evidence: { type: "array", maxItems: 2, items: { type: "string", maxLength: 240 } }
        },
        required: ["id"]
      }
    },
    warnings: {
      type: "array",
      maxItems: 4,
      description: "Provider-side caveats that should be shown to the player.",
      items: { type: "string", maxLength: 300 }
    }
  },
  required: ["summary", "decisionBriefNarrative", "actionPlanNarratives", "warnings"]
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
  private readonly maxTokensByProvider: Record<Provider, number>;

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
    const fallbackMaxTokens = numberEnv("LLM_MAX_TOKENS");
    this.maxTokensByProvider = {
      openai: options.maxTokensByProvider?.openai ?? numberEnv("OPENAI_MAX_TOKENS") ?? fallbackMaxTokens ?? DEFAULT_PROVIDER_MAX_TOKENS.openai,
      anthropic: options.maxTokensByProvider?.anthropic ?? numberEnv("ANTHROPIC_MAX_TOKENS") ?? fallbackMaxTokens ?? DEFAULT_PROVIDER_MAX_TOKENS.anthropic,
      gemini: options.maxTokensByProvider?.gemini ?? numberEnv("GEMINI_MAX_TOKENS") ?? fallbackMaxTokens ?? DEFAULT_PROVIDER_MAX_TOKENS.gemini
    };
  }

  async generateStructuredPlan(input: StructuredPlanInput): Promise<SitrepResponse> {
    let lastValidationError = "";
    let lastProviderText = "";
    let lastDiagnostics: LlmPayloadDiagnostics | undefined;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const prompt = attempt === 0 ? buildPrompt(input) : buildRepairPrompt(input, lastValidationError, lastProviderText);
      let text: string;
      let parsedJson: unknown;

      try {
        const result = await this.callProvider(input, prompt, attempt === 0 ? "compact" : "compact-repair");
        text = result.text;
        lastProviderText = text;
        lastDiagnostics = result.diagnostics;
        parsedJson = parseJsonObject(text);
      } catch (error) {
        if (error instanceof LlmProviderError) throw error;
        lastValidationError = error instanceof Error ? error.message : "Provider response could not be parsed.";
        continue;
      }

      const parsed = llmPlanDraftSchema.safeParse(parsedJson);
      if (parsed.success) {
        const draft = parsed.data;
        return {
          ...input.deterministicSitrep,
          summary: draft.summary,
          decisionBrief: mergeDecisionBriefNarrative(
            input.deterministicSitrep.decisionBrief,
            draft.decisionBriefNarrative,
            blockedTargetPhrases(input.deterministicSitrep)
          ),
          actionPlans: mergeActionPlanNarratives(input.deterministicSitrep.actionPlans, draft.actionPlanNarratives),
          provider: input.provider,
          model: input.model,
          rawSnapshot: input.snapshot,
          warnings: mergeWarnings(input.deterministicSitrep.warnings, draft.warnings),
          diagnostics: {
            source: "llm",
            timingsMs: {},
            ...lastDiagnostics
          }
        };
      }
      lastValidationError = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    }

    throw new LlmProviderError(`Provider returned JSON that did not match the LLM draft schema.${lastValidationError ? ` ${lastValidationError}` : ""}`, input.provider, undefined, input.model);
  }

  private async callProvider(input: StructuredPlanInput, prompt: string, payloadProfile: string): Promise<ProviderCallResult> {
    if (input.provider === "openai") return this.callOpenAi(input, prompt, payloadProfile);
    if (input.provider === "anthropic") return this.callAnthropic(input, prompt, payloadProfile);
    return this.callGemini(input, prompt, payloadProfile);
  }

  private async callOpenAi(input: StructuredPlanInput, prompt: string, payloadProfile: string): Promise<ProviderCallResult> {
    const outputTokenCap = this.maxTokensByProvider.openai;
    const requestBody = JSON.stringify({
      model: input.model,
      instructions: systemPrompt(),
      input: prompt,
      max_output_tokens: outputTokenCap,
      store: false,
      text: {
        format: {
          type: "json_schema",
          name: "gt_agent_plan_draft",
          schema: llmPlanDraftJsonSchema,
          strict: false
        }
      }
    });
    const response = await this.fetchProvider(input.provider, input.model, "https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.providerApiKey}`,
        "Content-Type": "application/json"
      },
      body: requestBody
    });

    const responseBody = await parseProviderResponse(response, input.provider, input.model);
    const content = extractOpenAiResponseText(responseBody);
    if (typeof content !== "string") throw new LlmProviderError("OpenAI response did not include message content.", input.provider, response.status, input.model);
    return { text: content, diagnostics: payloadDiagnostics(prompt, requestBody, outputTokenCap, payloadProfile) };
  }

  private async callAnthropic(input: StructuredPlanInput, prompt: string, payloadProfile: string): Promise<ProviderCallResult> {
    const outputTokenCap = this.maxTokensByProvider.anthropic;
    const requestBody = JSON.stringify({
      model: input.model,
      max_tokens: outputTokenCap,
      system: systemPrompt(),
      messages: [{ role: "user", content: prompt }]
    });
    const response = await this.fetchProvider(input.provider, input.model, "https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": input.providerApiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json"
      },
      body: requestBody
    });

    const body = await parseProviderResponse(response, input.provider, input.model);
    const text = body.content?.find((part: unknown) => isRecord(part) && part.type === "text")?.text;
    if (typeof text !== "string") throw new LlmProviderError("Anthropic response did not include text content.", input.provider, response.status, input.model);
    return { text, diagnostics: payloadDiagnostics(prompt, requestBody, outputTokenCap, payloadProfile) };
  }

  private async callGemini(input: StructuredPlanInput, prompt: string, payloadProfile: string): Promise<ProviderCallResult> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.model)}:generateContent?key=${encodeURIComponent(input.providerApiKey)}`;
    const outputTokenCap = this.maxTokensByProvider.gemini;
    const requestBody = JSON.stringify({
      contents: [{ role: "user", parts: [{ text: `${systemPrompt()}\n\n${prompt}` }] }],
      generationConfig: {
        maxOutputTokens: outputTokenCap,
        responseMimeType: "application/json",
        responseSchema: llmPlanDraftJsonSchema
      }
    });
    const response = await this.fetchProvider(input.provider, input.model, url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: requestBody
    });

    const body = await parseProviderResponse(response, input.provider, input.model);
    const text = body.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text ?? "").join("");
    if (typeof text !== "string" || text.length === 0) throw new LlmProviderError("Gemini response did not include text content.", input.provider, response.status, input.model);
    return { text, diagnostics: payloadDiagnostics(prompt, requestBody, outputTokenCap, payloadProfile) };
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

function buildPrompt(input: StructuredPlanInput): string {
  return buildCompactPrompt(input);
}

function buildRepairPrompt(input: StructuredPlanInput, validationError: string, previousResponse: string): string {
  const allowedActionIds = input.deterministicSitrep.actionPlans.slice(0, 3).map((plan) => ({
    id: plan.id,
    title: plan.title
  }));
  const alternativeTitles = input.deterministicSitrep.decisionBrief.alternatives.slice(0, 3).map((alternative) => alternative.title);
  return [
    `The previous JSON failed validation: ${validationError || "unknown validation error"}.`,
    "Return a corrected JSON object only with keys: summary, decisionBriefNarrative, actionPlanNarratives, warnings.",
    "Keep limits: summary <= 900 chars; decisionBriefNarrative lists <= 4; actionPlanNarratives <= 3 existing ids; evidence/pros/cons <= 2; warnings <= 4.",
    "Use only the allowed deterministic action ids and existing alternative titles below. Do not add actions, reorder actions, change scores, or promote blocked targets.",
    JSON.stringify({
      playerRequest: input.planningContext.userPrompt,
      allowedActionIds,
      alternativeTitles,
      previousResponseExcerpt: truncateText(previousResponse, 2200)
    })
  ].filter(Boolean).join("\n\n");
}

function buildCompactPrompt(input: StructuredPlanInput): string {
  const compact = buildCompactPromptPayload(input);
  return [
    input.planningContext.userPrompt ? `The player request to answer first: ${input.planningContext.userPrompt}` : "",
    "Return JSON only: summary, decisionBriefNarrative, actionPlanNarratives, warnings.",
    "Be concise: summary <= 900 chars; decision lists <= 4; narratives <= 3 existing action ids; each field <= 240 chars; evidence <= 2.",
    "Do not invent, reorder, promote, or demote actions. Deterministic ids, scores, math, buffer quantities, profitability, and timeline are final.",
    "Use watch/restock/avoid markets and blocked targets as context only unless a matching action id exists.",
    "Use display strings for money; raw GT money fields are cents.",
    JSON.stringify(compact)
  ].filter(Boolean).join("\n\n");
}

function buildCompactPromptPayload(input: StructuredPlanInput) {
  const sitrep = input.deterministicSitrep;
  const snapshotSummary = summarizeSnapshot(input.snapshot);
  return {
    request: {
      userPrompt: input.planningContext.userPrompt,
      goal: input.planningContext.shortTermGoal,
      notes: input.planningContext.notes,
      autonomyHours: input.planningContext.autonomyHours,
      cashRiskLevel: input.planningContext.cashRiskLevel,
      nextLoginAt: input.planningContext.nextLoginAt
    },
    company: {
      ...snapshotSummary.company,
      counts: snapshotSummary.counts
    },
    situation: compactAnthropicSituation(sitrep.situation),
    operationsBrief: compactOperationsBrief(sitrep.operationsBrief),
    decisionBrief: compactAnthropicDecisionBrief(sitrep.decisionBrief),
    timeline: sitrep.projections.bands.map((band) => ({
      horizonId: band.horizonId,
      summary: band.summary,
      confidence: band.confidence,
      actionIds: band.actionIds.slice(0, 3),
      needs: band.materialNeeds.slice(0, 2).map((need) => ({
        matName: need.matName,
        netNeedQty: need.netNeedQty
      })),
      constraints: band.constraints.slice(0, 2),
      inspectNext: band.inspectNext.slice(0, 2)
    })),
    actions: sitrep.actionPlans.slice(0, 3).map(compactAnthropicActionPlan),
    decisionActions: sitrep.decisionPanel.actions.slice(0, 3).map((action) => ({
      id: action.id,
      kind: action.kind,
      action: action.action,
      title: action.title,
      score: action.score,
      expectedValueDisplay: action.expectedValue !== undefined ? formatMoney(action.expectedValue) : undefined,
      cashImpactPct: action.cashImpactPct,
      blockers: action.blockers.slice(0, 2),
      evidence: action.evidence.slice(0, 2)
    })),
    profitability: compactAnthropicProfitability(sitrep.profitability),
    markets: sitrep.marketSignals.slice(0, 5).map((signal) => ({
      matName: signal.matName,
      recommendation: signal.recommendation,
      spreadPct: signal.spreadPct,
      spreadValue: signal.spreadValue,
      materialityPct: signal.materialityPct,
      ownedQty: signal.ownedQty,
      netNeedQty: signal.netNeedQty,
      liquidityScore: signal.liquidityScore,
      rationale: signal.rationale.slice(0, 2)
    })),
    risks: sitrep.stockoutRisks.slice(0, 4).map((risk) => ({
      matName: risk.matName,
      shortageQty: risk.shortageQty,
      hoursUntilStockout: risk.hoursUntilStockout,
      severity: risk.severity,
      affectedBases: risk.affectedBases.slice(0, 2)
    })),
    logistics: sitrep.logisticsMoves.slice(0, 3).map((move) => ({
      materialName: move.materialName,
      from: move.from,
      to: move.to,
      quantity: move.quantity,
      tonnes: move.tonnes,
      reason: move.reason
    })),
    trends: sitrep.trendSignals?.slice(0, 4).map((trend) => ({
      kind: trend.kind,
      severity: trend.severity,
      title: trend.title,
      summary: trend.summary
    })),
    warnings: sitrep.warnings.slice(0, 4)
  };
}

function summarizeSnapshot(snapshot: GameSnapshot) {
  const cashCents = numberValue(snapshot.company.cash);
  const valueCents = numberValue(snapshot.company.value);

  return {
    fetchedAt: snapshot.fetchedAt,
    company: {
      id: snapshot.company.id,
      name: snapshot.company.name,
      cashCents,
      cashDisplay: cashCents !== undefined ? formatMoney(cashCents) : undefined,
      rank: snapshot.company.rank,
      valueCents,
      valueDisplay: valueCents !== undefined ? formatMoney(valueCents) : undefined,
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

function compactOperationsBrief(brief: SitrepResponse["operationsBrief"]) {
  return {
    expectedIncome: {
      horizonHours: brief.expectedIncome.horizonHours,
      netProfitDisplay: formatMoney(brief.expectedIncome.netProfit),
      grossOutputValueDisplay: formatMoney(brief.expectedIncome.grossOutputValue),
      inputCostDisplay: formatMoney(brief.expectedIncome.inputCost),
      workerConsumableCostDisplay: brief.expectedIncome.workerConsumableCost !== undefined ? formatMoney(brief.expectedIncome.workerConsumableCost) : undefined,
      confidence: brief.expectedIncome.confidence,
      topLines: brief.expectedIncome.lines.slice(0, 3).map((line) => ({
        outputMatName: line.outputMatName,
        baseName: line.baseName,
        netProfitDisplay: formatMoney(line.netProfit),
        confidence: line.confidence
      }))
    },
    problems: brief.problems.slice(0, 4).map((problem) => ({
      type: problem.type,
      severity: problem.severity,
      title: problem.title,
      summary: problem.summary
    })),
    bufferPlan: {
      targetHours: brief.bufferPlan.targetHours,
      totalFillCostDisplay: formatMoney(brief.bufferPlan.totalFillCost),
      materials: brief.bufferPlan.materials.slice(0, 4).map((material) => ({
        matName: material.matName,
        coverageHours: material.coverageHours,
        buyQty: material.buyQty,
        estimatedCostDisplay: material.estimatedCost !== undefined ? formatMoney(material.estimatedCost) : undefined,
        urgency: material.urgency
      }))
    },
    surplusPlans: brief.surplusPlans.slice(0, 4).map((plan) => ({
      matName: plan.matName,
      surplusQty: plan.surplusQty,
      surplusValueDisplay: plan.surplusValue !== undefined ? formatMoney(plan.surplusValue) : undefined,
      recommendation: plan.recommendation,
      reason: plan.reason
    }))
  };
}

function compactAnthropicSituation(situation: SitrepResponse["situation"]) {
  if (!situation) return undefined;
  return {
    cash: {
      status: situation.cash.status,
      summary: situation.cash.summary,
      currentDisplay: situation.cash.current !== undefined ? formatMoney(situation.cash.current) : undefined,
      trendPct: situation.cash.trendPct
    },
    production: situation.production.summary,
    logistics: situation.logistics.summary,
    market: situation.market.summary,
    expansion: situation.expansion.summary,
    data: situation.dataQuality.summary
  };
}

function compactAnthropicDecisionBrief(brief: SitrepResponse["decisionBrief"]) {
  return {
    thesis: brief.thesis,
    recommendedPath: brief.recommendedPath.slice(0, 4),
    whyThisPath: brief.whyThisPath.slice(0, 4),
    alternatives: brief.alternatives.slice(0, 3).map((alternative) => ({
      title: alternative.title,
      pros: alternative.pros.slice(0, 2),
      cons: alternative.cons.slice(0, 2),
      chooseWhen: alternative.chooseWhen
    })),
    constraints: brief.constraints.slice(0, 4),
    inspectNext: brief.inspectNext.slice(0, 4),
    confidence: brief.confidence
  };
}

function compactAnthropicActionPlan(plan: SitrepResponse["actionPlans"][number]) {
  return {
    id: plan.id,
    title: plan.title,
    category: plan.category,
    score: plan.score,
    confidence: plan.confidence,
    horizonLabel: plan.horizonLabel,
    profitPerHourDisplay: plan.profitPerHour !== undefined ? `${formatMoney(plan.profitPerHour)}/h` : undefined,
    marginPct: plan.marginPct,
    capitalFit: plan.capitalFit,
    whyNow: plan.whyNow,
    expectedBenefit: plan.expectedBenefit,
    costSummary: plan.costSummary,
    risk: plan.risk,
    evidence: plan.evidence.slice(0, 2)
  };
}

function compactAnthropicProfitability(profitability: SitrepResponse["profitability"]) {
  if (!profitability) return undefined;
  return {
    companyFit: profitability.companyFit.slice(0, 3).map(compactAnthropicProfitabilityOpportunity),
    nextSteps: profitability.nextSteps.slice(0, 3).map(compactAnthropicProfitabilityOpportunity),
    aspirationalTargets: profitability.aspirationalTargets.slice(0, 2).map(compactAnthropicProfitabilityOpportunity),
    blockedTargets: profitability.blockedTargets.slice(0, 2).map(compactAnthropicProfitabilityOpportunity),
    chainOpportunities: profitability.chainOpportunities.slice(0, 3).map(compactAnthropicChainOpportunity),
    assumptions: profitability.assumptions.slice(0, 3),
    warnings: profitability.warnings.slice(0, 3)
  };
}

function compactAnthropicProfitabilityOpportunity(opportunity: NonNullable<SitrepResponse["profitability"]>["companyFit"][number]) {
  return {
    id: opportunity.id,
    kind: opportunity.kind,
    title: opportunity.title,
    recommendation: opportunity.recommendation,
    horizonLabel: opportunity.horizonLabel,
    score: opportunity.score,
    confidence: opportunity.confidence,
    profitPerHourDisplay: `${formatMoney(opportunity.profitPerHour)}/h`,
    marginPct: opportunity.marginPct,
    capitalFit: opportunity.capitalFit,
    setupDistance: opportunity.setupDistance,
    knownMinimumCapitalDisplay: opportunity.knownMinimumCapital !== undefined ? formatMoney(opportunity.knownMinimumCapital) : undefined,
    knownCapitalGapDisplay: opportunity.knownCapitalGap !== undefined ? formatMoney(opportunity.knownCapitalGap) : undefined,
    firstPracticalStep: opportunity.firstPracticalStep,
    blockers: uniqueCompactStrings([
      ...(opportunity.blockers ?? []),
      ...(opportunity.blockingReasons ?? []),
      ...(opportunity.unpricedRequirements ?? [])
    ], 3),
    rationale: opportunity.rationale.slice(0, 2)
  };
}

function compactAnthropicChainOpportunity(opportunity: NonNullable<SitrepResponse["chainOpportunities"]>[number]) {
  return {
    id: opportunity.id,
    kind: opportunity.kind,
    title: opportunity.title,
    recommendation: opportunity.recommendation,
    horizonLabel: opportunity.horizonLabel,
    score: opportunity.score,
    confidence: opportunity.confidence,
    profitPerHourDisplay: `${formatMoney(opportunity.profitPerHour)}/h`,
    marginPct: opportunity.marginPct,
    capitalFit: opportunity.capitalFit,
    setupDistance: opportunity.setupDistance,
    firstPracticalStep: opportunity.firstPracticalStep,
    blockers: uniqueCompactStrings([
      ...(opportunity.blockers ?? []),
      ...(opportunity.blockingReasons ?? []),
      ...(opportunity.unpricedRequirements ?? [])
    ], 3)
  };
}

function uniqueCompactStrings(items: Array<string | undefined>, limit: number): string[] {
  return [...new Set(items.filter((item): item is string => Boolean(item && item.trim())))].slice(0, limit);
}

function payloadDiagnostics(prompt: string, requestBody: string, outputTokenCap: number, payloadProfile: string): LlmPayloadDiagnostics {
  return {
    promptChars: prompt.length,
    requestBytes: new TextEncoder().encode(requestBody).length,
    outputTokenCap,
    roughInputTokens: Math.ceil(prompt.length / 4),
    payloadProfile
  };
}

function truncateText(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}...` : value;
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

function mergeDecisionBriefNarrative(
  brief: SitrepResponse["decisionBrief"],
  narrative: {
    thesis?: string;
    recommendedPath?: string[];
    whyThisPath?: string[];
    alternatives?: Array<{ title: string; pros?: string[]; cons?: string[]; chooseWhen?: string }>;
    constraints?: string[];
    inspectNext?: string[];
  },
  blockedPhrases: string[] = []
): SitrepResponse["decisionBrief"] {
  const alternativesByTitle = new Map((narrative.alternatives ?? []).map((alternative) => [alternative.title, alternative]));
  const narrativeRecommendedPath = narrative.recommendedPath?.length && !narrative.recommendedPath.some((item) => mentionsBlockedTarget(item, blockedPhrases))
    ? narrative.recommendedPath
    : undefined;
  return {
    ...brief,
    thesis: narrative.thesis || brief.thesis,
    recommendedPath: narrativeRecommendedPath ?? brief.recommendedPath,
    whyThisPath: narrative.whyThisPath?.length ? narrative.whyThisPath : brief.whyThisPath,
    constraints: narrative.constraints?.length ? narrative.constraints : brief.constraints,
    inspectNext: narrative.inspectNext?.length ? narrative.inspectNext : brief.inspectNext,
    alternatives: brief.alternatives.map((alternative) => {
      const update = alternativesByTitle.get(alternative.title);
      if (!update) return alternative;
      return {
        ...alternative,
        pros: update.pros?.length ? update.pros : alternative.pros,
        cons: update.cons?.length ? update.cons : alternative.cons,
        chooseWhen: update.chooseWhen || alternative.chooseWhen
      };
    })
  };
}

function blockedTargetPhrases(sitrep: SitrepResponse): string[] {
  return [...new Set((sitrep.profitability?.blockedTargets ?? []).flatMap((target) => [
    target.title,
    target.title.replace(/^Restructure toward /, ""),
    ...target.blockers,
    ...(target.blockingReasons ?? [])
  ]).map((value) => value.trim()).filter(Boolean))];
}

function mentionsBlockedTarget(text: string, blockedPhrases: string[]): boolean {
  const lower = text.toLowerCase();
  return blockedPhrases.some((phrase) => phrase.length >= 4 && lower.includes(phrase.toLowerCase()));
}

function mergeActionPlanNarratives(
  plans: SitrepResponse["actionPlans"],
  narratives: Array<{
    id: string;
    expectedBenefit?: string;
    risk?: string;
    whyNow?: string;
    bestWhen?: string;
    avoidIf?: string;
    whatWouldChangeThis?: string;
    evidence?: string[];
  }>
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
      bestWhen: narrative.bestWhen || plan.bestWhen,
      avoidIf: narrative.avoidIf || plan.avoidIf,
      whatWouldChangeThis: narrative.whatWouldChangeThis || plan.whatWouldChangeThis,
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
