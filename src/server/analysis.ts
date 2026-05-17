import type {
  ActionPlan,
  CompanySituation,
  ExpansionCandidate,
  GameSnapshot,
  LogisticsMove,
  MarketSignal,
  PlayerPlanningContext,
  Provider,
  SitrepResponse,
  StockoutRisk
} from "../shared/schemas.js";
import { computeStockoutRisks } from "./analysis/demand.js";
import { computeLogisticsMoves } from "./analysis/logistics.js";
import { computeMarketSignals } from "./analysis/market.js";
import { normalizeSnapshot } from "./analysis/normalizers.js";
import { buildStrategy } from "./analysis/strategy.js";

type AnalysisResult = {
  marketSignals: MarketSignal[];
  stockoutRisks: StockoutRisk[];
  expansionCandidates: ExpansionCandidate[];
  logisticsMoves: LogisticsMove[];
  actionPlans: ActionPlan[];
  situation: CompanySituation;
  summary: string;
  warnings: string[];
};

export function analyzeSnapshot(snapshot: GameSnapshot, context: PlayerPlanningContext): AnalysisResult {
  const normalized = normalizeSnapshot(snapshot, context);
  const marketSignals = computeMarketSignals(snapshot, normalized, context);
  const stockoutRisks = computeStockoutRisks(normalized, context);
  const logisticsMoves = computeLogisticsMoves(normalized, stockoutRisks);
  const strategy = buildStrategy(normalized, marketSignals, stockoutRisks, logisticsMoves, context);

  return {
    marketSignals,
    stockoutRisks,
    logisticsMoves,
    expansionCandidates: strategy.expansionCandidates,
    actionPlans: strategy.actionPlans,
    situation: strategy.situation,
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
    actionPlans: analysis.actionPlans,
    marketSignals: analysis.marketSignals,
    stockoutRisks: analysis.stockoutRisks,
    expansionCandidates: analysis.expansionCandidates,
    logisticsMoves: analysis.logisticsMoves,
    situation: analysis.situation,
    warnings: [...analysis.warnings, ...extraWarnings],
    rawSnapshot: snapshot
  };
}
