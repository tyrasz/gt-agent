import type { GameSnapshot, MarketSignal, PlayerPlanningContext, ProfitabilitySet } from "../../shared/schemas.js";
import type { NormalizedSnapshot } from "./normalizers.js";
import { profitabilityMarginByMaterial } from "./profitability.js";
import { clamp, formatMoney, formatPct, numberValue, recordArray, round, text } from "./utils.js";

export type MarketPosition = {
  matId: number;
  matName: string;
  currentPrice: number;
  avgPrice: number;
  spreadPct: number;
  totalQtyAvailable?: number;
  avgQtySoldDaily?: number;
  daysMarketSupply?: number;
  trend: MarketSignal["trend"];
  trendConfidence?: number;
  volatilityPct?: number;
  liquidityScore: number;
  recipeMarginPct?: number;
  ownedQty: number;
  neededQty: number;
  netNeedQty: number;
  cashImpactPct?: number;
  hasSellExposure: boolean;
};

export function computeMarketPositions(snapshot: GameSnapshot, normalized: NormalizedSnapshot, profitability?: ProfitabilitySet): MarketPosition[] {
  const recipeMargins = profitability ? profitabilityMarginByMaterial(profitability) : new Map<number, number>();
  const details = snapshot.market.details.length > 0 ? snapshot.market.details : snapshot.market.prices;

  return details
    .map((item) => {
      const matId = numberValue(item.matId) ?? numberValue(item.id) ?? 0;
      const mat = normalized.materials.get(matId);
      const matName = text(item.matName) || mat?.name || `Material ${matId}`;
      const currentPrice = numberValue(item.currentPrice) ?? -1;
      const avgPrice = numberValue(item.avgPrice) ?? -1;
      const totalQtyAvailable = numberValue(item.totalQtyAvailable);
      const avgQtySoldDaily = numberValue(item.avgQtySoldDaily);
      const history = recordArray(item.priceHistory);
      const daysMarketSupply = totalQtyAvailable !== undefined && avgQtySoldDaily && avgQtySoldDaily > 0 ? round(totalQtyAvailable / avgQtySoldDaily) : undefined;
      const spreadPct = currentPrice > 0 && avgPrice > 0 ? ((currentPrice - avgPrice) / avgPrice) * 100 : 0;
      const trend = priceTrend(history);
      const volatilityPct = priceVolatility(history);
      const trendConfidence = trend === "unknown" ? 20 : clamp(80 - (volatilityPct ?? 0));
      const liquidityScore = computeLiquidityScore(avgQtySoldDaily, totalQtyAvailable, daysMarketSupply);
      const demand = normalized.demand.get(matId);
      const inventory = normalized.inventory.get(matId);
      const neededQty = demand?.requiredQty ?? 0;
      const ownedQty = inventory?.totalQty ?? 0;
      const netNeedQty = Math.max(0, neededQty - ownedQty);
      const cashImpactPct = normalized.cash > 0 && currentPrice > 0 && netNeedQty > 0 ? round(((currentPrice * netNeedQty) / normalized.cash) * 100) : undefined;

      return {
        matId,
        matName,
        currentPrice,
        avgPrice,
        spreadPct: round(spreadPct),
        totalQtyAvailable,
        avgQtySoldDaily,
        daysMarketSupply,
        trend,
        trendConfidence: round(trendConfidence),
        volatilityPct,
        liquidityScore,
        recipeMarginPct: recipeMargins.get(matId),
        ownedQty,
        neededQty,
        netNeedQty: round(netNeedQty),
        cashImpactPct,
        hasSellExposure: ownedQty > 0 || hasExchangeOrder(snapshot.exchangeOrders, matId)
      } satisfies MarketPosition;
    })
    .filter((position) => position.matId > 0)
    .sort((a, b) => marketOpportunityScore(b) - marketOpportunityScore(a))
    .slice(0, 32);
}

export function computeMarketSignals(snapshot: GameSnapshot, normalized: NormalizedSnapshot, context: PlayerPlanningContext, profitability?: ProfitabilitySet): MarketSignal[] {
  return computeMarketPositions(snapshot, normalized, profitability)
    .map((position) => {
      const recommendation = marketRecommendation(position, context);
      const rationale = [
        position.currentPrice > 0 && position.avgPrice > 0 ? `${formatMoney(position.currentPrice)} current vs ${formatMoney(position.avgPrice)} recent average (${formatPct(position.spreadPct)}).` : "No reliable current/average price pair is available.",
        position.avgQtySoldDaily !== undefined ? `${Math.round(position.avgQtySoldDaily).toLocaleString()} avg units sold daily with ${position.daysMarketSupply ?? "unknown"} days of visible supply.` : "No daily sales velocity was reported.",
        position.netNeedQty > 0 ? `${Math.ceil(position.netNeedQty).toLocaleString()} net needed by current production/wishlist demand.` : `${Math.ceil(position.ownedQty).toLocaleString()} owned and no near-term net need detected.`,
        position.recipeMarginPct !== undefined ? `Best recipe margin estimate is ${formatPct(position.recipeMarginPct)} before logistics/time costs.` : "No direct recipe margin estimate was available."
      ];

      return {
        matId: position.matId,
        matName: position.matName,
        currentPrice: position.currentPrice,
        avgPrice: position.avgPrice,
        spreadPct: position.spreadPct,
        totalQtyAvailable: position.totalQtyAvailable,
        avgQtySoldDaily: position.avgQtySoldDaily,
        ownedQty: position.ownedQty,
        neededQty: position.neededQty,
        netNeedQty: position.netNeedQty,
        daysMarketSupply: position.daysMarketSupply,
        liquidityScore: position.liquidityScore,
        trendConfidence: position.trendConfidence,
        cashImpactPct: position.cashImpactPct,
        trend: position.trend,
        volatilityPct: position.volatilityPct,
        recipeMarginPct: position.recipeMarginPct,
        recommendation,
        rationale
      } satisfies MarketSignal;
    })
    .sort((a, b) => signalScore(b) - signalScore(a))
    .slice(0, 24);
}

function marketRecommendation(position: MarketPosition, context: PlayerPlanningContext): MarketSignal["recommendation"] {
  if (position.currentPrice <= 0 || position.avgPrice <= 0) return "avoid";
  const prompt = `${context.shortTermGoal} ${context.userPrompt ?? ""}`.toLowerCase();
  const promptMentions = prompt.includes(position.matName.toLowerCase());
  if (position.netNeedQty > 0) {
    if (position.spreadPct <= 10 && position.cashImpactPct !== undefined && position.cashImpactPct < cashRiskLimit(context.cashRiskLevel)) return "buy";
    return "restock";
  }
  if (position.hasSellExposure && position.spreadPct >= 18 && position.liquidityScore >= 25) return "sell";
  if ((position.recipeMarginPct ?? 0) >= 25 && position.spreadPct <= -10 && (context.cashRiskLevel === "aggressive" || promptMentions)) return "buy";
  return "watch";
}

function hasExchangeOrder(orders: Record<string, unknown>[], matId: number): boolean {
  return orders.some((order) => {
    const id = numberValue(order.matId) ?? numberValue(order.materialId) ?? numberValue(order.id) ?? numberValue(order.i);
    return id === matId;
  });
}

function marketOpportunityScore(position: MarketPosition): number {
  const needBonus = position.netNeedQty > 0 ? 35 : 0;
  const sellBonus = position.hasSellExposure && position.spreadPct > 0 ? 20 : 0;
  return needBonus + sellBonus + Math.abs(position.spreadPct) + position.liquidityScore / 2 + Math.max(0, position.recipeMarginPct ?? 0) - (position.volatilityPct ?? 0) / 2;
}

function signalScore(signal: MarketSignal): number {
  const fit = (signal.netNeedQty ?? 0) > 0 || signal.recommendation === "sell" ? 40 : 0;
  return fit + Math.abs(signal.spreadPct) + (signal.liquidityScore ?? 0) / 2 + Math.max(0, signal.recipeMarginPct ?? 0) - (signal.volatilityPct ?? 0) / 2;
}

function computeLiquidityScore(avgQtySoldDaily?: number, totalQtyAvailable?: number, daysMarketSupply?: number): number {
  const velocity = avgQtySoldDaily !== undefined ? clamp((avgQtySoldDaily / 1000) * 45) : 10;
  const depth = totalQtyAvailable !== undefined ? clamp((totalQtyAvailable / 10_000) * 35) : 10;
  const supply = daysMarketSupply !== undefined ? clamp(20 - Math.abs(daysMarketSupply - 3) * 4, 0, 20) : 5;
  return round(velocity + depth + supply);
}

function cashRiskLimit(level: PlayerPlanningContext["cashRiskLevel"]): number {
  if (level === "conservative") return 12;
  if (level === "aggressive") return 45;
  return 25;
}

function priceTrend(history: Record<string, unknown>[]): MarketSignal["trend"] {
  const prices = history.map((item) => numberValue(item.avgPrice)).filter((value): value is number => Boolean(value && value > 0));
  if (prices.length < 2) return "unknown";
  const newest = prices[0];
  const oldest = prices[prices.length - 1];
  const change = ((newest - oldest) / oldest) * 100;
  if (change > 5) return "up";
  if (change < -5) return "down";
  return "flat";
}

function priceVolatility(history: Record<string, unknown>[]): number | undefined {
  const prices = history.map((item) => numberValue(item.avgPrice)).filter((value): value is number => Boolean(value && value > 0));
  if (prices.length < 2) return undefined;
  const mean = prices.reduce((sum, value) => sum + value, 0) / prices.length;
  const variance = prices.reduce((sum, value) => sum + (value - mean) ** 2, 0) / prices.length;
  return round((Math.sqrt(variance) / mean) * 100);
}
