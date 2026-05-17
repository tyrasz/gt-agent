import type {
  ActionPlan,
  CompanySituation,
  DecisionBrief,
  ExpansionCandidate,
  GameSnapshot,
  LogisticsMove,
  MarketSignal,
  PlayerPlanningContext,
  ProfitabilitySet,
  Provider,
  ProjectionSet,
  SitrepResponse,
  StockoutRisk
} from "../shared/schemas.js";
import { computeStockoutRisks } from "./analysis/demand.js";
import { computeLogisticsMoves } from "./analysis/logistics.js";
import { computeMarketSignals } from "./analysis/market.js";
import { normalizeSnapshot } from "./analysis/normalizers.js";
import { computeProfitability } from "./analysis/profitability.js";
import { buildStrategy } from "./analysis/strategy.js";

type AnalysisResult = {
  marketSignals: MarketSignal[];
  stockoutRisks: StockoutRisk[];
  expansionCandidates: ExpansionCandidate[];
  logisticsMoves: LogisticsMove[];
  profitability: ProfitabilitySet;
  actionPlans: ActionPlan[];
  situation: CompanySituation;
  decisionBrief: DecisionBrief;
  projections: ProjectionSet;
  summary: string;
  warnings: string[];
};

export function analyzeSnapshot(snapshot: GameSnapshot, context: PlayerPlanningContext): AnalysisResult {
  const normalized = normalizeSnapshot(snapshot, context);
  const profitability = computeProfitability(snapshot, normalized, context);
  const marketSignals = computeMarketSignals(snapshot, normalized, context, profitability);
  const stockoutRisks = computeStockoutRisks(normalized, context);
  const logisticsMoves = computeLogisticsMoves(normalized, stockoutRisks);
  const strategy = buildStrategy(normalized, marketSignals, stockoutRisks, logisticsMoves, profitability, context);

  return {
    marketSignals,
    stockoutRisks,
    logisticsMoves,
    profitability,
    expansionCandidates: strategy.expansionCandidates,
    actionPlans: strategy.actionPlans,
    situation: strategy.situation,
    decisionBrief: strategy.decisionBrief,
    projections: strategy.projections,
    summary: strategy.summary,
    warnings: snapshot.warnings
  };
}

export function buildDeterministicSitrep(
  snapshot: GameSnapshot,
  context: PlayerPlanningContext,
  provider: Provider,
  model: string,
  extraWarnings: string[] = []
): SitrepResponse {
  const analysis = analyzeSnapshot(snapshot, context);
  return {
    generatedAt: new Date().toISOString(),
    provider,
    model,
    summary: analysis.summary,
    decisionBrief: analysis.decisionBrief,
    projections: analysis.projections,
    actionPlans: analysis.actionPlans,
    profitability: analysis.profitability,
    chainOpportunities: analysis.profitability.chainOpportunities,
    trendSignals: [],
    marketSignals: analysis.marketSignals,
    stockoutRisks: analysis.stockoutRisks,
    expansionCandidates: analysis.expansionCandidates,
    logisticsMoves: analysis.logisticsMoves,
    situation: analysis.situation,
    warnings: [...analysis.warnings, ...extraWarnings],
    rawSnapshot: snapshot
  };
}
