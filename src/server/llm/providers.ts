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
  decisionBriefNarrative: z.object({
    thesis: z.string().trim().optional(),
    recommendedPath: z.array(z.string()).optional(),
    whyThisPath: z.array(z.string()).optional(),
    alternatives: z.array(z.object({
      title: z.string().trim().min(1),
      pros: z.array(z.string()).optional(),
      cons: z.array(z.string()).optional(),
      chooseWhen: z.string().trim().optional()
    })).optional(),
    constraints: z.array(z.string()).optional(),
    inspectNext: z.array(z.string()).optional()
  }).default({}),
  actionPlanNarratives: z.array(z.object({
    id: z.string().trim().min(1),
    expectedBenefit: z.string().trim().optional(),
    risk: z.string().trim().optional(),
    whyNow: z.string().trim().optional(),
    bestWhen: z.string().trim().optional(),
    avoidIf: z.string().trim().optional(),
    whatWouldChangeThis: z.string().trim().optional(),
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
    decisionBriefNarrative: {
      type: "object",
      description: "Narrative updates for the existing deterministic Decision Brief. Preserve the deterministic decision shape and do not invent unsupported options.",
      additionalProperties: false,
      properties: {
        thesis: { type: "string" },
        recommendedPath: { type: "array", items: { type: "string" } },
        whyThisPath: { type: "array", items: { type: "string" } },
        alternatives: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              title: { type: "string" },
              pros: { type: "array", items: { type: "string" } },
              cons: { type: "array", items: { type: "string" } },
              chooseWhen: { type: "string" }
            },
            required: ["title"]
          }
        },
        constraints: { type: "array", items: { type: "string" } },
        inspectNext: { type: "array", items: { type: "string" } }
      }
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
          bestWhen: { type: "string" },
          avoidIf: { type: "string" },
          whatWouldChangeThis: { type: "string" },
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
          decisionBrief: mergeDecisionBriefNarrative(
            input.deterministicSitrep.decisionBrief,
            draft.decisionBriefNarrative,
            blockedTargetPhrases(input.deterministicSitrep)
          ),
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
        decisionActions: input.deterministicSitrep.decisionPanel.actions.length,
        marketSignals: input.deterministicSitrep.marketSignals.length,
        stockoutRisks: input.deterministicSitrep.stockoutRisks.length,
        expansionCandidates: input.deterministicSitrep.expansionCandidates.length,
        logisticsMoves: input.deterministicSitrep.logisticsMoves.length
      },
      decisionBrief: input.deterministicSitrep.decisionBrief,
      decisionPanel: compactDecisionPanel(input.deterministicSitrep.decisionPanel),
      projections: compactProjections(input.deterministicSitrep.projections),
      profitability: compactProfitability(input.deterministicSitrep.profitability),
      history: compactHistory(input.deterministicSitrep.history),
      trendSignals: input.deterministicSitrep.trendSignals?.slice(0, 8),
      chainOpportunities: input.deterministicSitrep.chainOpportunities?.slice(0, 6).map(compactChainOpportunity),
      topActionPlans: input.deterministicSitrep.actionPlans.slice(0, 5).map(compactActionPlan),
      topMarketSignals: input.deterministicSitrep.marketSignals.slice(0, 8).map(compactMarketSignal),
      topStockoutRisks: input.deterministicSitrep.stockoutRisks.slice(0, 8).map(compactStockoutRisk),
      topExpansionCandidates: input.deterministicSitrep.expansionCandidates.slice(0, 6).map(compactExpansionCandidate),
      topLogisticsMoves: input.deterministicSitrep.logisticsMoves.slice(0, 6).map(compactLogisticsMove),
      situation: compactSituation(input.deterministicSitrep.situation),
      warnings: input.deterministicSitrep.warnings
    }
  };

  return [
    validationHint,
    input.planningContext.userPrompt ? `The player request to answer first: ${input.planningContext.userPrompt}` : "",
    "Create only an LlmPlanDraft JSON object with these top-level keys: summary, decisionBriefNarrative, actionPlanNarratives, warnings.",
    "The deterministic strategy engine owns action ids, ranking, categories, scores, commands, and feasibility. Do not invent new action ids or reorder actions.",
    "For decisionBriefNarrative, improve wording for the existing deterministic Decision Brief only. Do not change confidence or add alternatives whose titles are not already present.",
    "For actionPlanNarratives, only reference ids present in topActionPlans and only improve expectedBenefit, risk, whyNow, bestWhen, avoidIf, whatWouldChangeThis, or evidence wording.",
    "Use projections to explain the timeline, but do not add horizons, change projected quantities, or alter projection actionIds.",
    "Use decisionPanel to explain contract and exchange choices, but do not add decision ids, reorder actions, or change contract/exchange feasibility.",
    "Market signals with recommendation watch, avoid, or restock are context only. Do not present them as highest-impact moves unless a matching deterministic action id exists.",
    "Use profitability to explain company-fit profit moves and feasible long-horizon restructure targets, but do not change profitability calculations or rankings.",
    "Blocked profitability targets are context only. Do not recommend blockedTargets as actions, timeline steps, or Decision Brief recommended-path items.",
    "Use history, trendSignals, and chainOpportunities to explain what persisted or changed, but do not change trend math, chain rankings, or action ids.",
    "Do not return provider, model, generatedAt, rawSnapshot, decisionPanel, profitability, marketSignals, stockoutRisks, expansionCandidates, logisticsMoves, score, scoreBreakdown, preparedCommands, priority, category, title, or costSummary.",
    "Use the situation, score breakdowns, profitability, and compact deterministic signals below to explain why the ranked plan is situationally valid.",
    "Money values from GT raw fields are integer cents. Use the provided display strings such as cashDisplay and costSummary in player-facing prose.",
    JSON.stringify(compact)
  ].filter(Boolean).join("\n\n");
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

function compactActionPlan(plan: SitrepResponse["actionPlans"][number]) {
  return {
    id: plan.id,
    title: plan.title,
    priority: plan.priority,
    category: plan.category,
    score: plan.score,
    confidence: plan.confidence,
    horizonLabel: plan.horizonLabel,
    latestUsefulByHours: plan.latestUsefulByHours,
    futureTriggers: plan.futureTriggers,
    whyNow: plan.whyNow,
    bestWhen: plan.bestWhen,
    avoidIf: plan.avoidIf,
    whatWouldChangeThis: plan.whatWouldChangeThis,
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
    grossValue: signal.grossValue,
    spreadValue: signal.spreadValue,
    materialityPct: signal.materialityPct,
    grossCashImpactPct: signal.grossCashImpactPct,
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

function compactSituation(situation: SitrepResponse["situation"]) {
  if (!situation) return undefined;
  return {
    cash: {
      status: situation.cash.status,
      score: situation.cash.score,
      summary: situation.cash.summary,
      currentCents: situation.cash.current,
      currentDisplay: situation.cash.current !== undefined ? formatMoney(situation.cash.current) : undefined,
      trendPct: situation.cash.trendPct
    },
    production: situation.production,
    logistics: situation.logistics,
    market: situation.market,
    expansion: situation.expansion,
    dataQuality: situation.dataQuality
  };
}

function compactDecisionPanel(panel: SitrepResponse["decisionPanel"]) {
  return {
    summary: panel.summary,
    actions: panel.actions.slice(0, 8).map((action) => ({
      id: action.id,
      kind: action.kind,
      action: action.action,
      title: action.title,
      priority: action.priority,
      score: action.score,
      confidence: action.confidence,
      expectedValue: action.expectedValue,
      expectedValueDisplay: action.expectedValue !== undefined ? formatMoney(action.expectedValue) : undefined,
      cashImpactPct: action.cashImpactPct,
      deadline: action.deadline,
      requirements: action.requirements.slice(0, 4),
      blockers: action.blockers.slice(0, 4),
      evidence: action.evidence.slice(0, 4),
      preparedCommands: action.preparedCommands.slice(0, 2).map((command) => ({
        type: command.type,
        title: command.title,
        executable: command.executable,
        steps: command.steps.slice(0, 4)
      }))
    })),
    warnings: panel.warnings
  };
}

function compactProjections(projections: SitrepResponse["projections"]) {
  return {
    horizons: projections.horizons,
    bands: projections.bands.map((band) => ({
      horizonId: band.horizonId,
      summary: band.summary,
      confidence: band.confidence,
      actionIds: band.actionIds,
      materialNeeds: band.materialNeeds.slice(0, 3).map((need) => ({
        matId: need.matId,
        matName: need.matName,
        requiredQty: need.requiredQty,
        availableQty: need.availableQty,
        netNeedQty: need.netNeedQty
      })),
      constraints: band.constraints.slice(0, 3),
      inspectNext: band.inspectNext.slice(0, 3)
    })),
    warnings: projections.warnings
  };
}

function compactProfitability(profitability: SitrepResponse["profitability"]) {
  if (!profitability) return undefined;
  return {
    companyFit: profitability.companyFit.slice(0, 5).map(compactProfitabilityOpportunity),
    nextSteps: profitability.nextSteps.slice(0, 5).map(compactProfitabilityOpportunity),
    aspirationalTargets: profitability.aspirationalTargets.slice(0, 5).map(compactProfitabilityOpportunity),
    blockedTargets: profitability.blockedTargets.slice(0, 5).map(compactProfitabilityOpportunity),
    globalTargets: profitability.globalTargets.slice(0, 5).map(compactProfitabilityOpportunity),
    chainOpportunities: profitability.chainOpportunities.slice(0, 5).map(compactChainOpportunity),
    chains: profitability.chains.slice(0, 5).map((chain) => ({
      id: chain.id,
      title: chain.title,
      recipeIds: chain.recipeIds,
      outputMatName: chain.outputMatName,
      totalNetProfitPerHour: chain.totalNetProfitPerHour,
      totalNetProfitPerHourDisplay: `${formatMoney(chain.totalNetProfitPerHour)}/h`,
      marginPct: chain.marginPct,
      inputCoveragePct: chain.inputCoveragePct,
      liquidityScore: chain.liquidityScore,
      companyFit: chain.companyFit,
      capitalFit: chain.capitalFit,
      setupDistance: chain.setupDistance,
      resourceAccess: chain.resourceAccess,
      setupCostCompleteness: chain.setupCostCompleteness,
      knownMinimumCapital: chain.knownMinimumCapital,
      knownMinimumCapitalDisplay: chain.knownMinimumCapital !== undefined ? formatMoney(chain.knownMinimumCapital) : undefined,
      knownCapitalGap: chain.knownCapitalGap,
      knownCapitalGapDisplay: chain.knownCapitalGap !== undefined ? formatMoney(chain.knownCapitalGap) : undefined,
      firstPracticalStep: chain.firstPracticalStep,
      missingPrerequisites: chain.missingPrerequisites?.slice(0, 4),
      unpricedRequirements: chain.unpricedRequirements?.slice(0, 4),
      blockingReasons: chain.blockingReasons?.slice(0, 4),
      confidence: chain.confidence,
      setupGaps: chain.setupGaps.slice(0, 4),
      steps: chain.steps.map((step) => ({
        recipeId: step.recipeId,
        outputMatName: step.outputMatName,
        buildingName: step.buildingName,
        netEstimatePerHour: step.netEstimatePerHour,
        companyFit: step.companyFit,
        capitalFit: step.capitalFit,
        resourceAccess: step.resourceAccess,
        setupCostCompleteness: step.setupCostCompleteness,
        blockingReasons: step.blockingReasons?.slice(0, 3)
      }))
    })),
    topRecipes: profitability.recipes.slice(0, 8).map((recipe) => ({
      recipeId: recipe.recipeId,
      recipeName: recipe.recipeName,
      outputMatName: recipe.outputMatName,
      buildingName: recipe.buildingName,
      netEstimatePerHour: recipe.netEstimatePerHour,
      netEstimatePerHourDisplay: `${formatMoney(recipe.netEstimatePerHour)}/h`,
      marginPct: recipe.marginPct,
      inputCoveragePct: recipe.inputCoveragePct,
      liquidityScore: recipe.liquidityScore,
      companyFit: recipe.companyFit,
      capitalFit: recipe.capitalFit,
      setupDistance: recipe.setupDistance,
      resourceAccess: recipe.resourceAccess,
      planetRequirement: recipe.planetRequirement,
      techRequirement: recipe.techRequirement,
      setupCostCompleteness: recipe.setupCostCompleteness,
      knownMinimumCapital: recipe.knownMinimumCapital,
      knownMinimumCapitalDisplay: recipe.knownMinimumCapital !== undefined ? formatMoney(recipe.knownMinimumCapital) : undefined,
      knownCapitalGap: recipe.knownCapitalGap,
      knownCapitalGapDisplay: recipe.knownCapitalGap !== undefined ? formatMoney(recipe.knownCapitalGap) : undefined,
      firstPracticalStep: recipe.firstPracticalStep,
      missingPrerequisites: recipe.missingPrerequisites?.slice(0, 4),
      unpricedRequirements: recipe.unpricedRequirements?.slice(0, 4),
      blockingReasons: recipe.blockingReasons?.slice(0, 4),
      setupGaps: recipe.setupGaps.slice(0, 4),
      confidence: recipe.priceConfidence
    })),
    assumptions: profitability.assumptions,
    warnings: profitability.warnings.slice(0, 5)
  };
}

function compactProfitabilityOpportunity(opportunity: NonNullable<SitrepResponse["profitability"]>["companyFit"][number]) {
  return {
    id: opportunity.id,
    kind: opportunity.kind,
    recipeId: opportunity.recipeId,
    title: opportunity.title,
    recommendation: opportunity.recommendation,
    horizonLabel: opportunity.horizonLabel,
    score: opportunity.score,
    confidence: opportunity.confidence,
    capitalFit: opportunity.capitalFit,
    setupDistance: opportunity.setupDistance,
    resourceAccess: opportunity.resourceAccess,
    planetRequirement: opportunity.planetRequirement,
    techRequirement: opportunity.techRequirement,
    setupCostCompleteness: opportunity.setupCostCompleteness,
    setupCostEstimate: opportunity.setupCostEstimate,
    knownMinimumCapital: opportunity.knownMinimumCapital,
    knownMinimumCapitalDisplay: opportunity.knownMinimumCapital !== undefined ? formatMoney(opportunity.knownMinimumCapital) : undefined,
    knownCapitalGap: opportunity.knownCapitalGap,
    knownCapitalGapDisplay: opportunity.knownCapitalGap !== undefined ? formatMoney(opportunity.knownCapitalGap) : undefined,
    cashImpactPct: opportunity.cashImpactPct,
    firstPracticalStep: opportunity.firstPracticalStep,
    missingPrerequisites: opportunity.missingPrerequisites?.slice(0, 4),
    unpricedRequirements: opportunity.unpricedRequirements?.slice(0, 4),
    blockingReasons: opportunity.blockingReasons?.slice(0, 4),
    profitPerHour: opportunity.profitPerHour,
    profitPerHourDisplay: `${formatMoney(opportunity.profitPerHour)}/h`,
    marginPct: opportunity.marginPct,
    rationale: opportunity.rationale.slice(0, 3),
    blockers: opportunity.blockers.slice(0, 4)
  };
}

function compactChainOpportunity(opportunity: NonNullable<SitrepResponse["chainOpportunities"]>[number]) {
  return {
    id: opportunity.id,
    kind: opportunity.kind,
    chainId: opportunity.chainId,
    title: opportunity.title,
    recommendation: opportunity.recommendation,
    horizonLabel: opportunity.horizonLabel,
    score: opportunity.score,
    confidence: opportunity.confidence,
    profitPerHour: opportunity.profitPerHour,
    profitPerHourDisplay: `${formatMoney(opportunity.profitPerHour)}/h`,
    marginPct: opportunity.marginPct,
    inputCoveragePct: opportunity.inputCoveragePct,
    capitalFit: opportunity.capitalFit,
    setupDistance: opportunity.setupDistance,
    resourceAccess: opportunity.resourceAccess,
    setupCostCompleteness: opportunity.setupCostCompleteness,
    setupCostEstimate: opportunity.setupCostEstimate,
    knownMinimumCapital: opportunity.knownMinimumCapital,
    knownMinimumCapitalDisplay: opportunity.knownMinimumCapital !== undefined ? formatMoney(opportunity.knownMinimumCapital) : undefined,
    knownCapitalGap: opportunity.knownCapitalGap,
    knownCapitalGapDisplay: opportunity.knownCapitalGap !== undefined ? formatMoney(opportunity.knownCapitalGap) : undefined,
    cashImpactPct: opportunity.cashImpactPct,
    firstPracticalStep: opportunity.firstPracticalStep,
    missingPrerequisites: opportunity.missingPrerequisites?.slice(0, 4),
    unpricedRequirements: opportunity.unpricedRequirements?.slice(0, 4),
    blockingReasons: opportunity.blockingReasons?.slice(0, 4),
    rationale: opportunity.rationale.slice(0, 3),
    blockers: opportunity.blockers.slice(0, 4)
  };
}

function compactHistory(history: SitrepResponse["history"]) {
  if (!history) return undefined;
  return {
    lastRunAt: history.lastRunAt,
    entries: history.entries.slice(-4).map((entry) => ({
      generatedAt: entry.generatedAt,
      companyName: entry.companyName,
      cash: entry.cash,
      companyValue: entry.companyValue,
      topActionTitle: entry.topActionTitle,
      highPriorityCount: entry.highPriorityCount,
      stockoutMatNames: entry.stockoutMatNames.slice(0, 4),
      profitableRecipeNames: entry.profitableRecipeNames.slice(0, 4),
      marketSignalMatNames: entry.marketSignalMatNames.slice(0, 4),
      chainNames: entry.chainNames.slice(0, 4)
    })),
    trendSignals: history.trendSignals.slice(0, 8)
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
