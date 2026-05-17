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
  grossValue?: number;
  spreadValue?: number;
  materialityPct?: number;
  grossCashImpactPct?: number;
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
      const sellGrossValue = currentPrice > 0 && ownedQty > 0 ? round(currentPrice * ownedQty) : undefined;
      const sellSpreadValue = currentPrice > 0 && avgPrice > 0 && ownedQty > 0 ? round(Math.max(0, currentPrice - avgPrice) * ownedQty) : undefined;
      const buyGrossValue = currentPrice > 0 && netNeedQty > 0 ? round(currentPrice * netNeedQty) : undefined;
      const buySpreadValue = currentPrice > 0 && avgPrice > 0 && netNeedQty > 0 ? round(Math.max(0, avgPrice - currentPrice) * netNeedQty) : undefined;
      const grossValue = sellGrossValue ?? buyGrossValue;
      const spreadValue = sellSpreadValue ?? buySpreadValue;
      const materialityPct = normalized.cash > 0 && spreadValue !== undefined ? round((spreadValue / normalized.cash) * 100) : undefined;
      const grossCashImpactPct = normalized.cash > 0 && grossValue !== undefined ? round((grossValue / normalized.cash) * 100) : undefined;

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
        grossValue,
        spreadValue,
        materialityPct,
        grossCashImpactPct,
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
        position.spreadValue !== undefined ? `Premium/discount value is about ${formatMoney(position.spreadValue)}${position.materialityPct !== undefined ? ` (${formatPct(position.materialityPct)} of visible cash)` : ""}.` : "No material dollar impact could be estimated for the spread.",
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
        grossValue: position.grossValue,
        spreadValue: position.spreadValue,
        materialityPct: position.materialityPct,
        grossCashImpactPct: position.grossCashImpactPct,
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
  if (position.hasSellExposure && position.spreadPct >= 18 && position.liquidityScore >= 25 && isMaterialSellOpportunity(position, context, promptMentions)) return "sell";
  if ((position.recipeMarginPct ?? 0) >= 25 && position.spreadPct <= -10 && (context.cashRiskLevel === "aggressive" || promptMentions)) return "buy";
  return "watch";
}

function isMaterialSellOpportunity(position: MarketPosition, context: PlayerPlanningContext, promptMentions: boolean): boolean {
  if (promptMentions) return true;
  const premiumPct = position.materialityPct ?? 0;
  const grossPct = position.grossCashImpactPct ?? 0;
  const premiumValue = position.spreadValue ?? 0;
  const minPremiumPct = context.cashRiskLevel === "conservative" ? 1.5 : context.cashRiskLevel === "aggressive" ? 0.5 : 1;
  const minGrossPct = context.cashRiskLevel === "conservative" ? 5 : context.cashRiskLevel === "aggressive" ? 2 : 3;
  const minPremiumValue = context.cashRiskLevel === "conservative" ? 50_000 : context.cashRiskLevel === "aggressive" ? 7_500 : 25_000;
  return premiumPct >= minPremiumPct && grossPct >= minGrossPct && premiumValue >= minPremiumValue;
}

function hasExchangeOrder(orders: Record<string, unknown>[], matId: number): boolean {
  return orders.some((order) => {
    const id = numberValue(order.matId) ?? numberValue(order.materialId) ?? numberValue(order.id) ?? numberValue(order.i);
    return id === matId;
  });
}

function marketOpportunityScore(position: MarketPosition): number {
  const needBonus = position.netNeedQty > 0 ? 35 : 0;
  const sellBonus = position.hasSellExposure && position.spreadPct > 0 ? materialityScore(position) * 0.45 : 0;
  return needBonus + sellBonus + Math.abs(position.spreadPct) * 0.6 + position.liquidityScore / 2 + Math.max(0, position.recipeMarginPct ?? 0) - (position.volatilityPct ?? 0) / 2;
}

function signalScore(signal: MarketSignal): number {
  const fit = (signal.netNeedQty ?? 0) > 0 ? 40 : signal.recommendation === "sell" ? 20 + materialityScore(signal) * 0.35 : 0;
  return fit + Math.abs(signal.spreadPct) * 0.6 + (signal.liquidityScore ?? 0) / 2 + Math.max(0, signal.recipeMarginPct ?? 0) - (signal.volatilityPct ?? 0) / 2;
}

function materialityScore(value: Pick<MarketPosition, "materialityPct" | "grossCashImpactPct" | "spreadValue">): number {
  const pctScore = clamp((value.materialityPct ?? 0) * 16);
  const grossScore = clamp((value.grossCashImpactPct ?? 0) * 4);
  const absoluteScore = clamp(((value.spreadValue ?? 0) / 100_000) * 60);
  return round(pctScore * 0.45 + grossScore * 0.25 + absoluteScore * 0.3);
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
