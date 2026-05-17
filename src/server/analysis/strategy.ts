import type {
  ActionPlan,
  CompanySituation,
  ExpansionCandidate,
  LogisticsMove,
  MarketSignal,
  MaterialAmount,
  PlayerPlanningContext,
  PreparedCommand,
  StockoutRisk
} from "../../shared/schemas.js";
import type { NormalizedSnapshot } from "./normalizers.js";
import { clamp, confidenceFromScore, formatMoney, formatPct, numberValue, priorityFromScore, round, severityScore, text } from "./utils.js";

export type StrategyResult = {
  situation: CompanySituation;
  expansionCandidates: ExpansionCandidate[];
  actionPlans: ActionPlan[];
  summary: string;
};

type ScoreBreakdown = NonNullable<ActionPlan["scoreBreakdown"]>;

export function buildStrategy(
  normalized: NormalizedSnapshot,
  marketSignals: MarketSignal[],
  stockoutRisks: StockoutRisk[],
  logisticsMoves: LogisticsMove[],
  context: PlayerPlanningContext
): StrategyResult {
  const expansionCandidates = computeExpansionCandidates(normalized, stockoutRisks, context);
  const situation = computeSituation(normalized, marketSignals, stockoutRisks, logisticsMoves, expansionCandidates);
  const actionPlans = buildActionPlans(normalized, marketSignals, stockoutRisks, logisticsMoves, expansionCandidates, context);
  const companyName = normalized.companyName;
  const lead = actionPlans[0]?.title ?? "market monitoring";
  const summary = `${companyName} has ${actionPlans.filter((plan) => plan.priority === "critical" || plan.priority === "high").length} high-priority moves for the next ${context.autonomyHours} hours, led by ${lead}.`;
  return { situation, expansionCandidates, actionPlans, summary };
}

function buildActionPlans(
  normalized: NormalizedSnapshot,
  marketSignals: MarketSignal[],
  stockoutRisks: StockoutRisk[],
  logisticsMoves: LogisticsMove[],
  expansionCandidates: ExpansionCandidate[],
  context: PlayerPlanningContext
): ActionPlan[] {
  const plans: ActionPlan[] = [];

  for (const risk of stockoutRisks.slice(0, 6)) {
    const currentPrice = marketSignals.find((signal) => signal.matId === risk.matId)?.currentPrice ?? 0;
    const cashImpactPct = normalized.cash > 0 && currentPrice > 0 ? ((currentPrice * risk.shortageQty) / normalized.cash) * 100 : 0;
    const breakdown = {
      urgency: scoreUrgency(risk),
      companyFit: 100,
      profitPotential: 10,
      marketConfidence: 55,
      feasibility: scoreCashFeasibility(cashImpactPct, context.cashRiskLevel),
      goalAlignment: scoreGoalAlignment(context, risk.matName, "restock")
    };
    const score = weightedScore(breakdown);
    plans.push(withScore({
      id: `restock-${risk.matId}`,
      title: `Restock ${risk.matName}`,
      priority: priorityFromScore(score),
      category: "operations",
      expectedBenefit: `Protects the next ${context.autonomyHours} hours of production demand.`,
      costSummary: `${Math.ceil(risk.shortageQty).toLocaleString()} units required${currentPrice > 0 ? `, about ${formatMoney(currentPrice * risk.shortageQty)}` : ""}.`,
      risk: risk.severity === "critical" ? "Production interruption is likely before the next check-in." : "Delay may reduce throughput if demand is not covered.",
      evidence: [`${risk.availableQty.toLocaleString()} available vs ${risk.requiredQty.toLocaleString()} required.`, ...risk.affectedBases],
      whyNow: risk.hoursUntilStockout !== undefined ? `${risk.matName} coverage is estimated at ${risk.hoursUntilStockout} hours, inside the ${context.autonomyHours}-hour planning window.` : `${risk.matName} is a current net requirement in this planning window.`,
      preparedCommands: [buyCommand(`Restock ${risk.matName}`, risk.matId, Math.ceil(risk.shortageQty), risk.matName)]
    }, score, breakdown));
  }

  for (const move of logisticsMoves.slice(0, 5)) {
    const breakdown = {
      urgency: 70,
      companyFit: 95,
      profitPotential: 5,
      marketConfidence: 50,
      feasibility: move.tonnes > 0 ? 75 : 20,
      goalAlignment: scoreGoalAlignment(context, move.materialName, "logistics")
    };
    const score = weightedScore(breakdown);
    plans.push(withScore({
      id: `move-${move.matId}-${plans.length}`,
      title: `Move ${move.materialName} to ${move.to}`,
      priority: priorityFromScore(score),
      category: "logistics",
      expectedBenefit: "Clears an inventory placement bottleneck with material already owned.",
      costSummary: `${Math.ceil(move.tonnes).toLocaleString()} tonnes of cargo capacity.`,
      risk: "Ship timing and current location must be checked in-game before dispatch.",
      evidence: [move.reason, `${move.quantity.toLocaleString()} ${move.materialName} available at ${move.from}.`],
      whyNow: `${move.materialName} is already owned but not positioned where demand is visible.`,
      preparedCommands: [{ type: "move_cargo", title: `Transfer ${move.materialName}`, executable: false, payload: move, steps: move.steps }]
    }, score, breakdown));
  }

  for (const signal of marketSignals.slice(0, 12)) {
    if (signal.recommendation === "buy" && !shouldCreateBuyAction(signal, context)) continue;
    if (signal.recommendation === "sell" && (signal.ownedQty ?? 0) <= 0) continue;
    if (signal.recommendation !== "buy" && signal.recommendation !== "sell") continue;

    const cashImpactPct = signal.cashImpactPct ?? 0;
    const breakdown = {
      urgency: signal.netNeedQty && signal.netNeedQty > 0 ? 65 : 25,
      companyFit: scoreCompanyFit(signal, context),
      profitPotential: scoreProfit(signal),
      marketConfidence: scoreMarketConfidence(signal),
      feasibility: signal.recommendation === "buy" ? scoreCashFeasibility(cashImpactPct, context.cashRiskLevel) : 80,
      goalAlignment: scoreGoalAlignment(context, signal.matName, signal.recommendation)
    };
    const score = weightedScore(breakdown);
    plans.push(withScore({
      id: `market-${signal.matId}`,
      title: `${signal.recommendation === "buy" ? "Buy" : "Reprice"} ${signal.matName}`,
      priority: priorityFromScore(score),
      category: "market",
      expectedBenefit: signal.recommendation === "buy" ? "Covers a company-specific need or profitable recipe input at favorable pricing." : "Captures above-average market pricing on inventory you can actually sell.",
      costSummary: signal.recommendation === "buy"
        ? `${formatMoney(signal.currentPrice)} current, ${signal.netNeedQty ? `${Math.ceil(signal.netNeedQty).toLocaleString()} net needed` : "speculative recipe input"}.`
        : `${Math.ceil(signal.ownedQty ?? 0).toLocaleString()} owned, ${formatPct(signal.spreadPct)} above average.`,
      risk: (signal.volatilityPct ?? 0) > 25 ? "High volatility means this should be checked manually before committing." : "Market price and order depth can change before manual execution.",
      evidence: signal.rationale,
      whyNow: signal.recommendation === "buy"
        ? `${signal.matName} is tied to current demand or a profitable recipe, not just a cheap headline price.`
        : `${signal.matName} has positive spread and visible owned inventory or sell exposure.`,
      preparedCommands: [
        signal.recommendation === "buy"
          ? buyCommand(`Check buy quantity for ${signal.matName}`, signal.matId, Math.ceil(signal.netNeedQty || 1), signal.matName)
          : {
              type: "adjust_sell_offer",
              title: `Review sell offer for ${signal.matName}`,
              executable: false,
              payload: { matId: signal.matId, currentPrice: signal.currentPrice, avgPrice: signal.avgPrice, ownedQty: signal.ownedQty },
              steps: [`Open ${signal.matName} on the Galactic Exchange.`, "Compare visible cheapest orders against this snapshot.", "Adjust only sell quantity you actually own or already listed."]
            }
      ]
    }, score, breakdown));
  }

  for (const candidate of expansionCandidates.slice(0, 4)) {
    const cashPenalty = context.cashRiskLevel === "conservative" ? 15 : context.cashRiskLevel === "aggressive" ? -5 : 5;
    const breakdown = {
      urgency: candidate.priority === "high" ? 65 : 40,
      companyFit: 75,
      profitPotential: 25,
      marketConfidence: 55,
      feasibility: clamp(70 - cashPenalty - candidate.blockers.length * 15),
      goalAlignment: scoreGoalAlignment(context, candidate.title, "expansion")
    };
    const score = weightedScore(breakdown);
    plans.push(withScore({
      id: `expand-${candidate.type}-${plans.length}`,
      title: candidate.title,
      priority: priorityFromScore(score),
      category: "expansion",
      expectedBenefit: "Reduces a structural bottleneck visible in the current company snapshot.",
      costSummary: candidate.requiredMaterials.length > 0 ? `${candidate.requiredMaterials.length} material groups to validate.` : "No material estimate in read-only snapshot.",
      risk: candidate.blockers.length > 0 ? candidate.blockers.join(" ") : "Expansion can trap cash if started before inputs and capacity are secured.",
      evidence: candidate.rationale,
      whyNow: candidate.rationale[0],
      preparedCommands: candidate.preparedCommands
    }, score, breakdown));
  }

  return plans.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 16);
}

function computeExpansionCandidates(normalized: NormalizedSnapshot, risks: StockoutRisk[], context: PlayerPlanningContext): ExpansionCandidate[] {
  const candidates: ExpansionCandidate[] = [];
  const maxUtilized = [...normalized.warehouses].sort((a, b) => b.utilization - a.utilization);

  for (const warehouse of maxUtilized.filter((item) => item.utilization > 0.85).slice(0, 3)) {
    candidates.push({
      title: `Increase capacity for ${warehouse.name}`,
      type: "warehouse",
      priority: warehouse.utilization > 0.95 ? "high" : "medium",
      requiredMaterials: [],
      blockers: context.cashRiskLevel === "conservative" ? ["Conservative cash mode: verify expansion costs before committing."] : [],
      rationale: [`${warehouse.name} is approximately ${formatPct(warehouse.utilization * 100)} full with ${warehouse.freeTonnes ?? "unknown"} tonnes free.`],
      preparedCommands: [reviewCommand("Review warehouse capacity project", { warehouseId: warehouse.id })]
    });
  }

  for (const base of normalized.bases) {
    const baseName = text(base.name) || `Base ${numberValue(base.id) ?? "?"}`;
    const slots = numberValue(base.buildingSlots);
    const productionOrders = Array.isArray(base.productionOrders) ? base.productionOrders.length : 0;
    if (slots !== undefined && productionOrders >= Math.max(1, slots - 1)) {
      candidates.push({
        title: `Relieve ${baseName} production slot pressure`,
        type: "building",
        priority: risks.some((risk) => risk.severity === "critical") ? "high" : "medium",
        requiredMaterials: risks.slice(0, 3).map((risk) => materialAmountFromRisk(risk, normalized)),
        blockers: risks.slice(0, 3).map((risk) => `${risk.matName}: ${Math.round(risk.shortageQty).toLocaleString()} short`),
        rationale: [`${baseName} has ${productionOrders} active production orders against ${slots} visible building slots.`],
        preparedCommands: [reviewCommand(`Review ${baseName} build queue`, { baseId: base.id })]
      });
    }
  }

  for (const plan of normalized.basePlans.slice(0, 4)) {
    const title = text(plan.title) || `Planet ${numberValue(plan.id) ?? "base"} plan`;
    candidates.push({
      title: `Audit ${title}`,
      type: "base_plan",
      priority: normalized.cash > 2_500_000 && context.cashRiskLevel !== "conservative" ? "high" : "medium",
      requiredMaterials: risks.slice(0, 5).map((risk) => materialAmountFromRisk(risk, normalized)),
      blockers: normalized.cash <= 0 ? ["Cash balance was unavailable or zero in the API snapshot."] : [],
      rationale: ["Base plan exists; validate its material needs against current shortages before committing cash."],
      preparedCommands: [reviewCommand(`Open ${title} base plan`, { planId: plan.id })]
    });
  }

  if (candidates.length === 0) {
    candidates.push({
      title: "Keep expansion optional until bottlenecks surface",
      type: "base_plan",
      priority: "low",
      requiredMaterials: [],
      blockers: [],
      rationale: ["No severe capacity or base-plan bottleneck was visible in the current read-only snapshot."],
      preparedCommands: [reviewCommand("Review long-range expansion choices", {})]
    });
  }

  return candidates.slice(0, 10);
}

function computeSituation(
  normalized: NormalizedSnapshot,
  marketSignals: MarketSignal[],
  stockoutRisks: StockoutRisk[],
  logisticsMoves: LogisticsMove[],
  expansionCandidates: ExpansionCandidate[]
): CompanySituation {
  const criticalRisks = stockoutRisks.filter((risk) => risk.severity === "critical").length;
  const highRisks = stockoutRisks.filter((risk) => risk.severity === "high").length;
  const warehouseMax = Math.max(0, ...normalized.warehouses.map((warehouse) => warehouse.utilization));
  const marketTop = Math.max(0, ...marketSignals.map((signal) => Math.max(0, signal.recipeMarginPct ?? 0) + Math.abs(signal.spreadPct) + (signal.liquidityScore ?? 0) / 2));
  const dataWarnings = normalized.warnings;

  return {
    cash: {
      current: normalized.cash,
      trendPct: normalized.cashTrendPct,
      score: normalized.cash <= 0 ? 80 : normalized.cash < 1_000_000 ? 55 : 20,
      status: normalized.cash <= 0 ? "high" : normalized.cash < 1_000_000 ? "medium" : "low",
      summary: normalized.cash > 0 ? `${formatMoney(normalized.cash)} cash available${normalized.cashTrendPct !== undefined ? `, ${formatPct(normalized.cashTrendPct)} recent trend` : ""}.` : "Cash unavailable in snapshot."
    },
    production: pressureSummary(criticalRisks > 0 ? 90 : highRisks > 0 ? 70 : stockoutRisks.length > 0 ? 45 : 15, `${stockoutRisks.length} material risks, ${criticalRisks} critical.`),
    logistics: pressureSummary(logisticsMoves.length > 0 ? 65 : warehouseMax > 0.9 ? 60 : 20, `${logisticsMoves.length} feasible transfers, max warehouse utilization ${formatPct(warehouseMax * 100)}.`),
    market: pressureSummary(clamp(marketTop), `${marketSignals.filter((signal) => signal.recommendation === "buy" || signal.recommendation === "sell").length} actionable market signals after company-fit filters.`),
    expansion: pressureSummary(expansionCandidates.some((candidate) => candidate.priority === "high") ? 65 : 35, `${expansionCandidates.length} expansion/base-plan candidates.`),
    dataQuality: {
      ...pressureSummary(dataWarnings.length > 0 ? 55 : 10, dataWarnings.length > 0 ? `${dataWarnings.length} snapshot warnings; review raw data before major moves.` : "No snapshot warnings."),
      warnings: dataWarnings
    }
  };
}

function pressureSummary(score: number, summary: string): CompanySituation["production"] {
  const rounded = round(score);
  return {
    score: rounded,
    status: rounded >= 85 ? "critical" : rounded >= 65 ? "high" : rounded >= 40 ? "medium" : "low",
    summary
  };
}

function withScore(plan: ActionPlan, score: number, breakdown: ScoreBreakdown): ActionPlan {
  return {
    ...plan,
    score: round(score),
    priority: priorityFromScore(score),
    confidence: confidenceFromScore((breakdown.companyFit + breakdown.marketConfidence + breakdown.feasibility) / 3),
    scoreBreakdown: Object.fromEntries(Object.entries(breakdown).map(([key, value]) => [key, round(value)]))
  };
}

function weightedScore(breakdown: ScoreBreakdown): number {
  return round(
    breakdown.urgency * 0.28 +
    breakdown.companyFit * 0.22 +
    breakdown.profitPotential * 0.16 +
    breakdown.marketConfidence * 0.12 +
    breakdown.feasibility * 0.15 +
    breakdown.goalAlignment * 0.07
  );
}

function scoreUrgency(risk: StockoutRisk): number {
  const severity = severityScore(risk.severity) * 22;
  const timing = risk.hoursUntilStockout !== undefined ? clamp(100 - risk.hoursUntilStockout * 5) : 45;
  return clamp(Math.max(severity, timing));
}

function scoreCompanyFit(signal: MarketSignal, context: PlayerPlanningContext): number {
  const prompt = `${context.shortTermGoal} ${context.userPrompt ?? ""}`.toLowerCase();
  if ((signal.netNeedQty ?? 0) > 0) return 95;
  if (signal.recommendation === "sell" && (signal.ownedQty ?? 0) > 0) return 85;
  if ((signal.recipeMarginPct ?? 0) >= 25 && prompt.includes(signal.matName.toLowerCase())) return 75;
  if ((signal.recipeMarginPct ?? 0) >= 25 && context.cashRiskLevel === "aggressive") return 55;
  return 20;
}

function scoreProfit(signal: MarketSignal): number {
  const spread = signal.recommendation === "sell" ? Math.max(0, signal.spreadPct) : Math.max(0, -signal.spreadPct);
  return clamp(spread + Math.max(0, signal.recipeMarginPct ?? 0));
}

function scoreMarketConfidence(signal: MarketSignal): number {
  return clamp((signal.liquidityScore ?? 25) * 0.7 + (signal.trendConfidence ?? 30) * 0.3 - (signal.volatilityPct ?? 0) * 0.7);
}

function scoreCashFeasibility(cashImpactPct: number, level: PlayerPlanningContext["cashRiskLevel"]): number {
  const limit = level === "conservative" ? 12 : level === "aggressive" ? 45 : 25;
  if (cashImpactPct <= 0) return 70;
  return clamp(100 - (cashImpactPct / limit) * 70);
}

function scoreGoalAlignment(context: PlayerPlanningContext, label: string, category: string): number {
  const prompt = `${context.shortTermGoal} ${context.userPrompt ?? ""} ${context.notes ?? ""}`.toLowerCase();
  if (prompt.includes(label.toLowerCase())) return 100;
  if (category === "restock" && /restock|production|input|short|bottleneck/.test(prompt)) return 85;
  if (category === "logistics" && /logistics|move|ship|cargo|transfer/.test(prompt)) return 85;
  if (category === "sell" && /market|sell|profit|price/.test(prompt)) return 80;
  if (category === "buy" && /market|buy|restock|input/.test(prompt)) return 75;
  if (category === "expansion" && /expand|base|building|warehouse/.test(prompt)) return 80;
  return 45;
}

function shouldCreateBuyAction(signal: MarketSignal, context: PlayerPlanningContext): boolean {
  const prompt = `${context.shortTermGoal} ${context.userPrompt ?? ""}`.toLowerCase();
  if ((signal.netNeedQty ?? 0) > 0) return true;
  if ((signal.recipeMarginPct ?? 0) >= 25 && (context.cashRiskLevel === "aggressive" || prompt.includes(signal.matName.toLowerCase()))) return true;
  return false;
}

function buyCommand(title: string, matId: number, quantity: number, matName: string): PreparedCommand {
  return {
    type: "buy_material",
    title,
    executable: false,
    payload: { matId, quantity },
    steps: [
      `Open ${matName} on the Galactic Exchange.`,
      `Check whether at least ${quantity.toLocaleString()} units are still available near the snapshot price.`,
      "Buy only the quantity that still matches current production need and cash-risk settings."
    ]
  };
}

function materialAmountFromRisk(risk: StockoutRisk, normalized: NormalizedSnapshot): MaterialAmount {
  return {
    matId: risk.matId,
    matName: risk.matName,
    quantity: risk.shortageQty,
    tonnes: risk.shortageQty * (normalized.materials.get(risk.matId)?.weight ?? 1)
  };
}

function reviewCommand(title: string, payload: Record<string, unknown>): PreparedCommand {
  return {
    type: "review",
    title,
    executable: false,
    payload,
    steps: ["Open the relevant in-game screen.", "Compare current game state against this snapshot.", "Apply only the manual changes that still match current conditions."]
  };
}
