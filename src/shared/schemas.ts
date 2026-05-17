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
  category: z.enum(["market", "operations", "logistics", "expansion", "risk"]),
  score: z.number().optional(),
  confidence: z.enum(["low", "medium", "high"]).optional(),
  whyNow: z.string().optional(),
  scoreBreakdown: z.record(z.number()).optional(),
  expectedBenefit: z.string(),
  costSummary: z.string(),
  risk: z.string(),
  evidence: z.array(z.string()),
  preparedCommands: z.array(preparedCommandSchema).default([])
});
export type ActionPlan = z.infer<typeof actionPlanSchema>;

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
  actionPlans: z.array(actionPlanSchema),
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
