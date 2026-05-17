import { z } from "zod";

export const providerSchema = z.enum(["openai", "anthropic", "gemini"]);
export type Provider = z.infer<typeof providerSchema>;

export const providerKeysSchema = z.object({
  openai: z.string().trim().min(1).optional(),
  anthropic: z.string().trim().min(1).optional(),
  gemini: z.string().trim().min(1).optional()
});
export type ProviderKeys = z.infer<typeof providerKeysSchema>;

const booleanQuerySchema = z.preprocess((value) => {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}, z.boolean());

export const sessionKeysRequestSchema = z.object({
  gtApiKey: z.string().trim().min(8, "Enter a Galactic Tycoons API key."),
  providerKeys: providerKeysSchema.refine((keys) => Object.keys(keys).length > 0, {
    message: "Enter at least one provider API key."
  })
});
export type SessionKeysRequest = z.infer<typeof sessionKeysRequestSchema>;

export const modelCatalogQuerySchema = z.object({
  provider: providerSchema,
  refresh: booleanQuerySchema.optional()
});
export type ModelCatalogQuery = z.infer<typeof modelCatalogQuerySchema>;

export const modelOptionSchema = z.object({
  id: z.string(),
  label: z.string().optional(),
  source: z.enum(["provider", "fallback"]).optional()
});
export type ModelOption = z.infer<typeof modelOptionSchema>;

export const modelCatalogResponseSchema = z.object({
  provider: providerSchema,
  defaultModel: z.string(),
  models: z.array(modelOptionSchema),
  warnings: z.array(z.string()).default([])
});
export type ModelCatalogResponse = z.infer<typeof modelCatalogResponseSchema>;

export const cashRiskLevelSchema = z.enum(["conservative", "balanced", "aggressive"]);

export const playerPlanningContextSchema = z.object({
  nextLoginAt: z.string().trim().optional(),
  autonomyHours: z.number().min(1).max(168),
  projectionHours: z.array(z.number().min(1).max(168)).min(1).max(6).optional(),
  cashRiskLevel: cashRiskLevelSchema,
  shortTermGoal: z.string().trim().min(2).max(240),
  userPrompt: z.string().trim().max(2000).optional(),
  notes: z.string().trim().max(1000).optional()
});
export type PlayerPlanningContext = z.infer<typeof playerPlanningContextSchema>;

export const refreshOptionsSchema = z.object({
  forceCompany: z.boolean().optional(),
  forceMarket: z.boolean().optional(),
  forceGameData: z.boolean().optional()
}).optional();
export type RefreshOptions = z.infer<typeof refreshOptionsSchema>;

export const sitrepRequestSchema = z.object({
  provider: providerSchema,
  model: z.string().trim().min(1),
  planningContext: playerPlanningContextSchema,
  refresh: refreshOptionsSchema
});
export type SitrepRequest = z.infer<typeof sitrepRequestSchema>;

export const materialAmountSchema = z.object({
  matId: z.number(),
  matName: z.string(),
  quantity: z.number(),
  tonnes: z.number().optional()
});
export type MaterialAmount = z.infer<typeof materialAmountSchema>;

export const preparedCommandSchema = z.object({
  type: z.enum([
    "buy_material",
    "move_cargo",
    "start_production",
    "adjust_sell_offer",
    "save_base_plan",
    "review"
  ]),
  title: z.string(),
  executable: z.literal(false),
  payload: z.record(z.unknown()).default({}),
  steps: z.array(z.string()).default([])
});
export type PreparedCommand = z.infer<typeof preparedCommandSchema>;

export const marketSignalSchema = z.object({
  matId: z.number(),
  matName: z.string(),
  currentPrice: z.number(),
  avgPrice: z.number(),
  spreadPct: z.number(),
  totalQtyAvailable: z.number().optional(),
  avgQtySoldDaily: z.number().optional(),
  ownedQty: z.number().optional(),
  neededQty: z.number().optional(),
  netNeedQty: z.number().optional(),
  grossValue: z.number().optional(),
  spreadValue: z.number().optional(),
  materialityPct: z.number().optional(),
  grossCashImpactPct: z.number().optional(),
  daysMarketSupply: z.number().optional(),
  liquidityScore: z.number().optional(),
  trendConfidence: z.number().optional(),
  cashImpactPct: z.number().optional(),
  trend: z.enum(["up", "down", "flat", "unknown"]),
  volatilityPct: z.number().optional(),
  recipeMarginPct: z.number().optional(),
  recommendation: z.enum(["buy", "sell", "watch", "avoid", "restock"]),
  rationale: z.array(z.string())
});
export type MarketSignal = z.infer<typeof marketSignalSchema>;

export const capitalFitSchema = z.enum(["affordable", "stretch", "blocked", "unknown"]);
export type CapitalFit = z.infer<typeof capitalFitSchema>;

export const setupDistanceSchema = z.enum(["ready", "one_step", "multi_step", "unreachable_now"]);
export type SetupDistance = z.infer<typeof setupDistanceSchema>;

export const setupCostCompletenessSchema = z.enum(["complete", "partial", "unknown"]);
export type SetupCostCompleteness = z.infer<typeof setupCostCompletenessSchema>;

export const profitabilityRecipeSchema = z.object({
  recipeId: z.number(),
  recipeName: z.string(),
  outputMatId: z.number(),
  outputMatName: z.string(),
  inputMatIds: z.array(z.number()).default([]),
  buildingId: z.number().optional(),
  buildingName: z.string().optional(),
  industry: z.string().optional(),
  inputCostPerHour: z.number(),
  outputValuePerHour: z.number(),
  grossProfitPerHour: z.number(),
  workerConsumableCostPerHour: z.number().optional(),
  netEstimatePerHour: z.number(),
  marginPct: z.number().optional(),
  profitPer100Burden: z.number().optional(),
  outputUnitsPerHour: z.number(),
  inputCoveragePct: z.number(),
  liquidityScore: z.number(),
  priceConfidence: z.enum(["low", "medium", "high"]),
  companyFit: z.enum(["owned", "active", "available", "target"]),
  capitalFit: capitalFitSchema.optional(),
  setupDistance: setupDistanceSchema.optional(),
  resourceAccess: z.enum(["owned", "available", "blocked", "unknown"]).optional(),
  planetRequirement: z.string().optional(),
  techRequirement: z.string().optional(),
  setupCostCompleteness: setupCostCompletenessSchema.optional(),
  setupCostEstimate: z.number().optional(),
  knownMinimumCapital: z.number().optional(),
  knownCapitalGap: z.number().optional(),
  cashAfterSetup: z.number().optional(),
  cashImpactPct: z.number().optional(),
  firstPracticalStep: z.string().optional(),
  missingPrerequisites: z.array(z.string()).default([]).optional(),
  unpricedRequirements: z.array(z.string()).default([]).optional(),
  blockingReasons: z.array(z.string()).default([]).optional(),
  setupGaps: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([])
});
export type ProfitabilityRecipe = z.infer<typeof profitabilityRecipeSchema>;

export const profitabilityOpportunitySchema = z.object({
  id: z.string(),
  kind: z.enum(["run_now", "stage_inputs", "reprice_output", "expand_for_recipe", "restructure_toward"]),
  recipeId: z.number(),
  title: z.string(),
  recommendation: z.string(),
  horizonId: z.string(),
  horizonLabel: z.string(),
  score: z.number(),
  confidence: z.enum(["low", "medium", "high"]),
  profitPerHour: z.number(),
  marginPct: z.number().optional(),
  capitalFit: capitalFitSchema.optional(),
  setupDistance: setupDistanceSchema.optional(),
  resourceAccess: z.enum(["owned", "available", "blocked", "unknown"]).optional(),
  planetRequirement: z.string().optional(),
  techRequirement: z.string().optional(),
  setupCostCompleteness: setupCostCompletenessSchema.optional(),
  setupCostEstimate: z.number().optional(),
  knownMinimumCapital: z.number().optional(),
  knownCapitalGap: z.number().optional(),
  cashAfterSetup: z.number().optional(),
  cashImpactPct: z.number().optional(),
  firstPracticalStep: z.string().optional(),
  missingPrerequisites: z.array(z.string()).default([]).optional(),
  unpricedRequirements: z.array(z.string()).default([]).optional(),
  blockingReasons: z.array(z.string()).default([]).optional(),
  rationale: z.array(z.string()).default([]),
  blockers: z.array(z.string()).default([]),
  actionId: z.string().optional()
});
export type ProfitabilityOpportunity = z.infer<typeof profitabilityOpportunitySchema>;

export const productionChainStepSchema = z.object({
  recipeId: z.number(),
  recipeName: z.string(),
  outputMatId: z.number(),
  outputMatName: z.string(),
  buildingName: z.string().optional(),
  netEstimatePerHour: z.number(),
  marginPct: z.number().optional(),
  companyFit: z.enum(["owned", "active", "available", "target"]),
  capitalFit: capitalFitSchema.optional(),
  setupDistance: setupDistanceSchema.optional(),
  resourceAccess: z.enum(["owned", "available", "blocked", "unknown"]).optional(),
  setupCostCompleteness: setupCostCompletenessSchema.optional(),
  knownMinimumCapital: z.number().optional(),
  knownCapitalGap: z.number().optional(),
  unpricedRequirements: z.array(z.string()).default([]).optional(),
  blockingReasons: z.array(z.string()).default([]).optional(),
  setupGaps: z.array(z.string()).default([])
});
export type ProductionChainStep = z.infer<typeof productionChainStepSchema>;

export const productionChainSchema = z.object({
  id: z.string(),
  title: z.string(),
  recipeIds: z.array(z.number()).default([]),
  outputMatId: z.number(),
  outputMatName: z.string(),
  steps: z.array(productionChainStepSchema).default([]),
  totalInputCostPerHour: z.number(),
  totalOutputValuePerHour: z.number(),
  totalNetProfitPerHour: z.number(),
  marginPct: z.number().optional(),
  inputCoveragePct: z.number(),
  liquidityScore: z.number(),
  setupGaps: z.array(z.string()).default([]),
  companyFit: z.enum(["active", "owned", "available", "target"]),
  capitalFit: capitalFitSchema.optional(),
  setupDistance: setupDistanceSchema.optional(),
  resourceAccess: z.enum(["owned", "available", "blocked", "unknown"]).optional(),
  setupCostCompleteness: setupCostCompletenessSchema.optional(),
  setupCostEstimate: z.number().optional(),
  knownMinimumCapital: z.number().optional(),
  knownCapitalGap: z.number().optional(),
  cashAfterSetup: z.number().optional(),
  cashImpactPct: z.number().optional(),
  firstPracticalStep: z.string().optional(),
  missingPrerequisites: z.array(z.string()).default([]).optional(),
  unpricedRequirements: z.array(z.string()).default([]).optional(),
  blockingReasons: z.array(z.string()).default([]).optional(),
  confidence: z.enum(["low", "medium", "high"]),
  warnings: z.array(z.string()).default([])
});
export type ProductionChain = z.infer<typeof productionChainSchema>;

export const chainOpportunitySchema = z.object({
  id: z.string(),
  kind: z.enum(["deepen_chain", "stage_chain", "restructure_chain"]),
  chainId: z.string(),
  title: z.string(),
  recommendation: z.string(),
  horizonId: z.string(),
  horizonLabel: z.string(),
  score: z.number(),
  confidence: z.enum(["low", "medium", "high"]),
  profitPerHour: z.number(),
  marginPct: z.number().optional(),
  inputCoveragePct: z.number().optional(),
  capitalFit: capitalFitSchema.optional(),
  setupDistance: setupDistanceSchema.optional(),
  resourceAccess: z.enum(["owned", "available", "blocked", "unknown"]).optional(),
  setupCostCompleteness: setupCostCompletenessSchema.optional(),
  setupCostEstimate: z.number().optional(),
  knownMinimumCapital: z.number().optional(),
  knownCapitalGap: z.number().optional(),
  cashAfterSetup: z.number().optional(),
  cashImpactPct: z.number().optional(),
  firstPracticalStep: z.string().optional(),
  missingPrerequisites: z.array(z.string()).default([]).optional(),
  unpricedRequirements: z.array(z.string()).default([]).optional(),
  blockingReasons: z.array(z.string()).default([]).optional(),
  rationale: z.array(z.string()).default([]),
  blockers: z.array(z.string()).default([]),
  actionId: z.string().optional()
});
export type ChainOpportunity = z.infer<typeof chainOpportunitySchema>;

export const profitabilitySetSchema = z.object({
  recipes: z.array(profitabilityRecipeSchema).default([]),
  companyFit: z.array(profitabilityOpportunitySchema).default([]),
  nextSteps: z.array(profitabilityOpportunitySchema).default([]),
  aspirationalTargets: z.array(profitabilityOpportunitySchema).default([]),
  blockedTargets: z.array(profitabilityOpportunitySchema).default([]),
  globalTargets: z.array(profitabilityOpportunitySchema).default([]),
  chains: z.array(productionChainSchema).default([]),
  chainOpportunities: z.array(chainOpportunitySchema).default([]),
  assumptions: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([])
});
export type ProfitabilitySet = z.infer<typeof profitabilitySetSchema>;

export const stockoutRiskSchema = z.object({
  matId: z.number(),
  matName: z.string(),
  availableQty: z.number(),
  requiredQty: z.number(),
  shortageQty: z.number(),
  hoursUntilStockout: z.number().optional(),
  severity: z.enum(["low", "medium", "high", "critical"]),
  affectedBases: z.array(z.string())
});
export type StockoutRisk = z.infer<typeof stockoutRiskSchema>;

export const logisticsMoveSchema = z.object({
  from: z.string(),
  to: z.string(),
  matId: z.number(),
  materialName: z.string(),
  quantity: z.number(),
  tonnes: z.number(),
  shipName: z.string().optional(),
  reason: z.string(),
  steps: z.array(z.string())
});
export type LogisticsMove = z.infer<typeof logisticsMoveSchema>;

export const expansionCandidateSchema = z.object({
  title: z.string(),
  type: z.enum(["base", "building", "warehouse", "fleet", "base_plan"]),
  priority: z.enum(["low", "medium", "high", "critical"]),
  estimatedCost: z.number().optional(),
  requiredMaterials: z.array(materialAmountSchema).default([]),
  blockers: z.array(z.string()).default([]),
  rationale: z.array(z.string()).default([]),
  preparedCommands: z.array(preparedCommandSchema).default([])
});
export type ExpansionCandidate = z.infer<typeof expansionCandidateSchema>;

export const actionPlanSchema = z.object({
  id: z.string(),
  title: z.string(),
  priority: z.enum(["low", "medium", "high", "critical"]),
  category: z.enum(["market", "operations", "logistics", "expansion", "risk", "profitability"]),
  score: z.number().optional(),
  confidence: z.enum(["low", "medium", "high"]).optional(),
  profitPerHour: z.number().optional(),
  marginPct: z.number().optional(),
  profitabilityTag: z.string().optional(),
  capitalFit: capitalFitSchema.optional(),
  setupDistance: setupDistanceSchema.optional(),
  whyNow: z.string().optional(),
  bestWhen: z.string().optional(),
  avoidIf: z.string().optional(),
  whatWouldChangeThis: z.string().optional(),
  horizonId: z.string().optional(),
  horizonLabel: z.string().optional(),
  latestUsefulByHours: z.number().optional(),
  futureTriggers: z.array(z.string()).optional(),
  scoreBreakdown: z.record(z.number()).optional(),
  expectedBenefit: z.string(),
  costSummary: z.string(),
  risk: z.string(),
  evidence: z.array(z.string()),
  preparedCommands: z.array(preparedCommandSchema).default([])
});
export type ActionPlan = z.infer<typeof actionPlanSchema>;

export const decisionRequirementSchema = z.object({
  matId: z.number(),
  matName: z.string(),
  quantity: z.number(),
  availableQty: z.number().optional(),
  shortageQty: z.number().optional(),
  estimatedCost: z.number().optional()
});
export type DecisionRequirement = z.infer<typeof decisionRequirementSchema>;

export const decisionPanelActionSchema = z.object({
  id: z.string(),
  kind: z.enum(["contract", "exchange"]),
  action: z.enum([
    "fulfill_contract",
    "prepare_contract",
    "review_contract",
    "skip_contract",
    "buy_material",
    "adjust_sell_offer",
    "review_exchange"
  ]),
  title: z.string(),
  priority: z.enum(["low", "medium", "high", "critical"]),
  score: z.number(),
  confidence: z.enum(["low", "medium", "high"]),
  expectedValue: z.number().optional(),
  cashImpactPct: z.number().optional(),
  deadline: z.string().optional(),
  requirements: z.array(decisionRequirementSchema).default([]),
  blockers: z.array(z.string()).default([]),
  evidence: z.array(z.string()).default([]),
  preparedCommands: z.array(preparedCommandSchema).default([])
});
export type DecisionPanelAction = z.infer<typeof decisionPanelActionSchema>;

export const decisionPanelSchema = z.object({
  summary: z.string(),
  actions: z.array(decisionPanelActionSchema).default([]),
  warnings: z.array(z.string()).default([])
});
export type DecisionPanel = z.infer<typeof decisionPanelSchema>;

export const decisionBriefAlternativeSchema = z.object({
  title: z.string(),
  pros: z.array(z.string()).default([]),
  cons: z.array(z.string()).default([]),
  chooseWhen: z.string()
});
export type DecisionBriefAlternative = z.infer<typeof decisionBriefAlternativeSchema>;

export const decisionBriefSchema = z.object({
  thesis: z.string(),
  recommendedPath: z.array(z.string()).default([]),
  whyThisPath: z.array(z.string()).default([]),
  alternatives: z.array(decisionBriefAlternativeSchema).default([]),
  constraints: z.array(z.string()).default([]),
  inspectNext: z.array(z.string()).default([]),
  confidence: z.enum(["low", "medium", "high"])
});
export type DecisionBrief = z.infer<typeof decisionBriefSchema>;

export const projectionHorizonSchema = z.object({
  id: z.string(),
  label: z.string(),
  hours: z.number()
});
export type ProjectionHorizon = z.infer<typeof projectionHorizonSchema>;

export const projectedMaterialNeedSchema = z.object({
  horizonId: z.string(),
  horizonLabel: z.string(),
  hours: z.number(),
  matId: z.number(),
  matName: z.string(),
  requiredQty: z.number(),
  availableQty: z.number(),
  netNeedQty: z.number(),
  tonnes: z.number().optional()
});
export type ProjectedMaterialNeed = z.infer<typeof projectedMaterialNeedSchema>;

export const projectionBandSchema = z.object({
  horizonId: z.string(),
  summary: z.string(),
  confidence: z.enum(["low", "medium", "high"]),
  actionIds: z.array(z.string()).default([]),
  materialNeeds: z.array(projectedMaterialNeedSchema).default([]),
  constraints: z.array(z.string()).default([]),
  inspectNext: z.array(z.string()).default([])
});
export type ProjectionBand = z.infer<typeof projectionBandSchema>;

export const projectionSetSchema = z.object({
  horizons: z.array(projectionHorizonSchema),
  bands: z.array(projectionBandSchema),
  materialNeeds: z.array(projectedMaterialNeedSchema),
  warnings: z.array(z.string()).default([])
});
export type ProjectionSet = z.infer<typeof projectionSetSchema>;

export const pressureSummarySchema = z.object({
  status: z.enum(["low", "medium", "high", "critical"]),
  score: z.number(),
  summary: z.string()
});
export type PressureSummary = z.infer<typeof pressureSummarySchema>;

export const companySituationSchema = z.object({
  cash: pressureSummarySchema.extend({
    current: z.number().optional(),
    trendPct: z.number().optional()
  }),
  production: pressureSummarySchema,
  logistics: pressureSummarySchema,
  market: pressureSummarySchema,
  expansion: pressureSummarySchema,
  dataQuality: pressureSummarySchema.extend({
    warnings: z.array(z.string()).default([])
  })
});
export type CompanySituation = z.infer<typeof companySituationSchema>;

export const trendSignalSchema = z.object({
  id: z.string(),
  kind: z.enum(["cash", "company_value", "stockout", "profitability", "market", "recommendation"]),
  severity: z.enum(["info", "positive", "warning", "critical"]),
  title: z.string(),
  summary: z.string(),
  current: z.number().optional(),
  previous: z.number().optional(),
  delta: z.number().optional(),
  deltaPct: z.number().optional(),
  count: z.number().optional(),
  actionIds: z.array(z.string()).default([]),
  evidence: z.array(z.string()).default([])
});
export type TrendSignal = z.infer<typeof trendSignalSchema>;

export const snapshotHistoryEntrySchema = z.object({
  id: z.string(),
  generatedAt: z.string(),
  fetchedAt: z.string().optional(),
  companyName: z.string(),
  cash: z.number().optional(),
  companyValue: z.number().optional(),
  topActionTitle: z.string().optional(),
  topActionIds: z.array(z.string()).default([]),
  highPriorityCount: z.number(),
  stockoutMatIds: z.array(z.number()).default([]),
  stockoutMatNames: z.array(z.string()).default([]),
  profitableRecipeIds: z.array(z.number()).default([]),
  profitableRecipeNames: z.array(z.string()).default([]),
  marketSignalMatIds: z.array(z.number()).default([]),
  marketSignalMatNames: z.array(z.string()).default([]),
  chainIds: z.array(z.string()).default([]),
  chainNames: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([])
});
export type SnapshotHistoryEntry = z.infer<typeof snapshotHistoryEntrySchema>;

export const historySummarySchema = z.object({
  entries: z.array(snapshotHistoryEntrySchema).default([]),
  trendSignals: z.array(trendSignalSchema).default([]),
  lastRunAt: z.string().optional()
});
export type HistorySummary = z.infer<typeof historySummarySchema>;

export const scenarioMaterialDeltaSchema = z.object({
  matId: z.number(),
  matName: z.string(),
  quantityDelta: z.number(),
  cashDelta: z.number().optional()
});
export type ScenarioMaterialDelta = z.infer<typeof scenarioMaterialDeltaSchema>;

export const whatIfScenarioRequestSchema = z.object({
  scenarioType: z.enum(["buy_material", "build_expansion", "start_recipe", "switch_production", "stage_inputs", "increase_buffer"]),
  planningContext: playerPlanningContextSchema,
  matId: z.number().optional(),
  recipeId: z.number().optional(),
  quantity: z.number().min(0).optional(),
  cashSpend: z.number().min(0).optional(),
  bufferHours: z.number().min(1).max(168).optional(),
  description: z.string().trim().max(500).optional()
});
export type WhatIfScenarioRequest = z.infer<typeof whatIfScenarioRequestSchema>;

export const whatIfScenarioStateSchema = z.object({
  title: z.string(),
  summary: z.string(),
  cash: z.number().optional(),
  cashDisplay: z.string().optional(),
  profitPerHour: z.number().optional(),
  profitPerHourDisplay: z.string().optional(),
  materialDeltas: z.array(scenarioMaterialDeltaSchema).default([]),
  productionImpact: z.array(z.string()).default([]),
  risk: z.enum(["low", "medium", "high", "critical"]),
  blockers: z.array(z.string()).default([])
});
export type WhatIfScenarioState = z.infer<typeof whatIfScenarioStateSchema>;

export const whatIfScenarioResultSchema = z.object({
  generatedAt: z.string(),
  scenarioType: whatIfScenarioRequestSchema.shape.scenarioType,
  title: z.string(),
  baseline: whatIfScenarioStateSchema,
  scenario: whatIfScenarioStateSchema,
  deltas: z.object({
    cash: z.number().optional(),
    profitPerHour: z.number().optional(),
    materials: z.array(scenarioMaterialDeltaSchema).default([])
  }),
  recommendedChoice: z.enum(["baseline", "scenario", "defer"]),
  rationale: z.array(z.string()).default([]),
  blockers: z.array(z.string()).default([]),
  preparedCommands: z.array(preparedCommandSchema).default([]),
  warnings: z.array(z.string()).default([])
});
export type WhatIfScenarioResult = z.infer<typeof whatIfScenarioResultSchema>;

export const rateLimitInfoSchema = z.object({
  endpoint: z.string(),
  remaining: z.number().optional(),
  resetSeconds: z.number().optional(),
  retryAfterSeconds: z.number().optional()
});
export type RateLimitInfo = z.infer<typeof rateLimitInfoSchema>;

export const gameSnapshotSchema = z.object({
  fetchedAt: z.string(),
  company: z.record(z.unknown()),
  bases: z.array(z.record(z.unknown())),
  warehouses: z.array(z.record(z.unknown())),
  exchangeOrders: z.array(z.record(z.unknown())),
  cashHistory: z.array(z.record(z.unknown())),
  contracts: z.array(z.record(z.unknown())),
  basePlans: z.array(z.record(z.unknown())),
  wishlists: z.array(z.record(z.unknown())),
  market: z.object({
    prices: z.array(z.record(z.unknown())),
    details: z.array(z.record(z.unknown()))
  }),
  gameData: z.record(z.unknown()),
  rateLimits: z.array(rateLimitInfoSchema).default([]),
  warnings: z.array(z.string()).default([])
});
export type GameSnapshot = z.infer<typeof gameSnapshotSchema>;

export const sitrepResponseSchema = z.object({
  generatedAt: z.string(),
  provider: providerSchema,
  model: z.string(),
  summary: z.string(),
  decisionBrief: decisionBriefSchema,
  decisionPanel: decisionPanelSchema,
  projections: projectionSetSchema,
  actionPlans: z.array(actionPlanSchema),
  profitability: profitabilitySetSchema.optional(),
  history: historySummarySchema.optional(),
  trendSignals: z.array(trendSignalSchema).default([]).optional(),
  chainOpportunities: z.array(chainOpportunitySchema).default([]).optional(),
  marketSignals: z.array(marketSignalSchema),
  stockoutRisks: z.array(stockoutRiskSchema),
  expansionCandidates: z.array(expansionCandidateSchema),
  logisticsMoves: z.array(logisticsMoveSchema),
  warnings: z.array(z.string()).default([]),
  situation: companySituationSchema.optional(),
  diagnostics: z.object({
    source: z.enum(["llm", "deterministic"]),
    timingsMs: z.record(z.number()),
    llmMessage: z.string().optional()
  }).optional(),
  rawSnapshot: gameSnapshotSchema.optional()
});
export type SitrepResponse = z.infer<typeof sitrepResponseSchema>;

export const apiErrorSchema = z.object({
  error: z.string(),
  details: z.unknown().optional()
});
export type ApiError = z.infer<typeof apiErrorSchema>;
