import type {
  ActionPlan,
  CompanySituation,
  DecisionBrief,
  ExpansionCandidate,
  LogisticsMove,
  MarketSignal,
  MaterialAmount,
  PlayerPlanningContext,
  ProjectedMaterialNeed,
  PreparedCommand,
  ChainOpportunity,
  ProfitabilityOpportunity,
  ProfitabilitySet,
  ProjectionSet,
  StockoutRisk
} from "../../shared/schemas.js";
import type { NormalizedSnapshot } from "./normalizers.js";
import { addProjectionTiming, buildProjectionBase, buildProjections, earliestNeedForMaterial, projectionNeedScore } from "./projections.js";
import { clamp, confidenceFromScore, formatMoney, formatPct, numberValue, priorityFromScore, round, severityScore, text } from "./utils.js";

export type StrategyResult = {
  situation: CompanySituation;
  decisionBrief: DecisionBrief;
  projections: ProjectionSet;
  expansionCandidates: ExpansionCandidate[];
  actionPlans: ActionPlan[];
  summary: string;
};

type ScoreBreakdown = NonNullable<ActionPlan["scoreBreakdown"]>;
export type PlanningIntent = "cv_growth" | "production_stability" | "market_profit" | "expansion" | "logistics" | "risk_review" | "general_sitrep";

export function buildStrategy(
  normalized: NormalizedSnapshot,
  marketSignals: MarketSignal[],
  stockoutRisks: StockoutRisk[],
  logisticsMoves: LogisticsMove[],
  profitability: ProfitabilitySet,
  context: PlayerPlanningContext
): StrategyResult {
  const intent = classifyPlanningIntent(context);
  const expansionCandidates = computeExpansionCandidates(normalized, stockoutRisks, context, intent);
  const situation = computeSituation(normalized, marketSignals, stockoutRisks, logisticsMoves, expansionCandidates, profitability);
  const projectionBase = buildProjectionBase(normalized, context);
  const actionPlans = addProjectionTiming(
    buildActionPlans(normalized, marketSignals, stockoutRisks, logisticsMoves, expansionCandidates, profitability, context, intent, projectionBase),
    projectionBase
  );
  const projections = buildProjections(normalized, actionPlans, context);
  const decisionBrief = buildDecisionBrief(normalized, situation, marketSignals, stockoutRisks, logisticsMoves, expansionCandidates, profitability, actionPlans, projections, context, intent);
  const companyName = normalized.companyName;
  const lead = actionPlans[0]?.title ?? "market monitoring";
  const summary = `${companyName} has ${actionPlans.filter((plan) => plan.priority === "critical" || plan.priority === "high").length} high-priority moves for the next ${context.autonomyHours} hours, led by ${lead}.`;
  return { situation, decisionBrief, projections, expansionCandidates, actionPlans, summary };
}

export function classifyPlanningIntent(context: PlayerPlanningContext): PlanningIntent {
  const text = `${context.userPrompt ?? ""} ${context.shortTermGoal} ${context.notes ?? ""}`.toLowerCase();
  if (/\bcv\b|company value|increase.*value|valuation|rank up|ranking|grow value/.test(text)) return "cv_growth";
  if (/risk|safe|danger|exposure|avoid|conservative|audit|review/.test(text)) return "risk_review";
  if (/\b(logistics|cargo|ship|transfer|route|warehouse)\b|\bmove\b/.test(text)) return "logistics";
  if (/expand|expansion|base plan|new base|building|slot|capacity/.test(text)) return "expansion";
  if (/market|profit|margin|sell|reprice|trade|exchange|arbitrage/.test(text)) return "market_profit";
  if (/production|restock|stockout|input|supply|keep.*running|shortage|bottleneck/.test(text)) return "production_stability";
  return "general_sitrep";
}

function buildActionPlans(
  normalized: NormalizedSnapshot,
  marketSignals: MarketSignal[],
  stockoutRisks: StockoutRisk[],
  logisticsMoves: LogisticsMove[],
  expansionCandidates: ExpansionCandidate[],
  profitability: ProfitabilitySet,
  context: PlayerPlanningContext,
  intent: PlanningIntent,
  projectionBase: Pick<ProjectionSet, "horizons" | "materialNeeds">
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
      goalAlignment: scoreGoalAlignment(context, intent, risk.matName, "restock")
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
      bestWhen: "Use this when current production inputs are below the next-login coverage target.",
      avoidIf: "Avoid overbuying if the in-game order book moved sharply or the production order was already completed.",
      whatWouldChangeThis: "A new base inventory snapshot or cheaper local source could reduce the buy quantity.",
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
      goalAlignment: scoreGoalAlignment(context, intent, move.materialName, "logistics")
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
      bestWhen: "Use this when the material is already owned and the destination still has enough free storage.",
      avoidIf: "Avoid if the source and destination changed in-game or a ship is needed elsewhere first.",
      whatWouldChangeThis: "A fresh warehouse snapshot showing the material already at destination would remove this move.",
      preparedCommands: [{ type: "move_cargo", title: `Transfer ${move.materialName}`, executable: false, payload: move, steps: move.steps }]
    }, score, breakdown));
  }

  for (const signal of marketSignals.slice(0, 12)) {
    if (signal.recommendation === "buy" && !shouldCreateBuyAction(signal, context)) continue;
    if (signal.recommendation === "sell" && (signal.ownedQty ?? 0) <= 0) continue;
    if (signal.recommendation !== "buy" && signal.recommendation !== "sell") continue;

    const cashImpactPct = signal.cashImpactPct ?? 0;
    const materiality = scoreMarketMateriality(signal);
    const breakdown = {
      urgency: signal.netNeedQty && signal.netNeedQty > 0 ? 65 : 25,
      companyFit: scoreCompanyFit(signal, context),
      profitPotential: scoreProfit(signal),
      marketConfidence: scoreMarketConfidence(signal),
      feasibility: signal.recommendation === "buy" ? scoreCashFeasibility(cashImpactPct, context.cashRiskLevel) : clamp(45 + materiality * 0.45),
      goalAlignment: scoreGoalAlignment(context, intent, signal.matName, signal.recommendation)
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
        : `${Math.ceil(signal.ownedQty ?? 0).toLocaleString()} owned, ${formatPct(signal.spreadPct)} above average; spread value about ${formatMoney(signal.spreadValue ?? 0)}${signal.materialityPct !== undefined ? ` (${formatPct(signal.materialityPct)} of cash)` : ""}.`,
      risk: (signal.volatilityPct ?? 0) > 25 ? "High volatility means this should be checked manually before committing." : "Market price and order depth can change before manual execution.",
      evidence: signal.rationale,
      whyNow: signal.recommendation === "buy"
        ? `${signal.matName} is tied to current demand or a profitable recipe, not just a cheap headline price.`
        : `${signal.matName} has positive spread, visible owned inventory, and enough absolute premium value to pass the company materiality gate.`,
      bestWhen: signal.recommendation === "buy" ? "Use this when the in-game price is still near the snapshot and the material feeds current demand or a strong recipe." : "Use this when visible bids or cheapest listings still support the above-average repricing.",
      avoidIf: signal.recommendation === "buy" ? "Avoid if this is only cheap with no confirmed demand, recipe margin, or prompt match." : "Avoid if you no longer own the material or listed depth collapsed.",
      whatWouldChangeThis: "A new exchange refresh with changed depth, trend, or volatility can move this below operational work.",
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
      goalAlignment: scoreGoalAlignment(context, intent, candidate.title, "expansion")
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
      bestWhen: "Use this when it removes a visible capacity ceiling or supports a proven production chain.",
      avoidIf: "Avoid committing cash if inputs, downstream demand, or facility requirements are still unknown.",
      whatWouldChangeThis: "A profitable base-plan material list or new bottleneck would raise this from prepare/review to execute.",
      preparedCommands: candidate.preparedCommands
    }, score, breakdown));
  }

  addProfitabilityPlans(plans, profitability, stockoutRisks, context, intent);
  addProjectedRestockPlans(plans, normalized, marketSignals, stockoutRisks, context, intent, projectionBase);

  return plans.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 16);
}

function addProfitabilityPlans(
  plans: ActionPlan[],
  profitability: ProfitabilitySet,
  stockoutRisks: StockoutRisk[],
  context: PlayerPlanningContext,
  intent: PlanningIntent
): void {
  const existingRecipeIds = new Set<number>();
  const urgentOperations = stockoutRisks.some((risk) => risk.severity === "critical" || risk.severity === "high");

  for (const opportunity of profitability.companyFit.slice(0, 4)) {
    addProfitabilityPlan(plans, opportunity, context, intent, urgentOperations);
    existingRecipeIds.add(opportunity.recipeId);
  }

  for (const opportunity of (profitability.nextSteps ?? []).filter((item) => !existingRecipeIds.has(item.recipeId)).slice(0, 4)) {
    addProfitabilityPlan(plans, opportunity, context, intent, urgentOperations);
  }

  for (const opportunity of (profitability.chainOpportunities ?? []).filter((item) => item.capitalFit === "affordable").slice(0, 4)) {
    addChainPlan(plans, opportunity, context, intent, urgentOperations);
  }
}

function addProfitabilityPlan(
  plans: ActionPlan[],
  opportunity: ProfitabilityOpportunity,
  context: PlayerPlanningContext,
  intent: PlanningIntent,
  urgentOperations: boolean
): void {
  const scoreCap = opportunity.kind === "restructure_toward"
    ? intent === "cv_growth" || intent === "market_profit" ? 68 : 58
    : 100;
  const urgency = opportunity.kind === "run_now" ? 56 : opportunity.kind === "stage_inputs" ? 46 : opportunity.kind === "expand_for_recipe" ? 34 : 24;
  const companyFit = opportunity.kind === "run_now" ? 96 : opportunity.kind === "stage_inputs" ? 86 : opportunity.kind === "expand_for_recipe" ? 62 : 38;
  const confidence = opportunity.confidence === "high" ? 88 : opportunity.confidence === "medium" ? 62 : 36;
  const breakdown = {
    urgency: urgentOperations ? Math.max(20, urgency - 18) : urgency,
    companyFit,
    profitPotential: clamp(opportunity.score),
    marketConfidence: confidence,
    feasibility: clamp(82 - opportunity.blockers.length * 11),
    goalAlignment: scoreGoalAlignment(context, intent, opportunity.title, "profitability")
  };
  const score = Math.min(weightedScore(breakdown), scoreCap);
  const id = `profit-${opportunity.kind}-${opportunity.recipeId}`;
  plans.push(withScore({
    id,
    title: opportunity.title,
    priority: priorityFromScore(score),
    category: "profitability",
    horizonId: opportunity.horizonId,
    horizonLabel: opportunity.horizonLabel,
    latestUsefulByHours: opportunity.horizonId === "h12" ? 12 : opportunity.horizonId === "d1" ? 24 : opportunity.horizonId === "d3" ? 72 : 168,
    profitPerHour: opportunity.profitPerHour,
    marginPct: opportunity.marginPct,
    profitabilityTag: opportunity.kind === "expand_for_recipe" ? "next feasible step" : "company-fit",
    capitalFit: opportunity.capitalFit,
    setupDistance: opportunity.setupDistance,
    expectedBenefit: `${formatMoney(opportunity.profitPerHour)}/h estimated net value${opportunity.marginPct !== undefined ? ` at ${formatPct(opportunity.marginPct)} margin` : ""}.`,
    costSummary: opportunity.setupCostEstimate && opportunity.setupCostEstimate > 0
      ? `${formatMoney(opportunity.setupCostEstimate)} setup estimate; ${opportunity.cashImpactPct ?? 0}% of visible cash.`
      : opportunity.blockers.length > 0 ? opportunity.blockers.join(" ") : "No major setup gap visible from the read-only snapshot.",
    risk: opportunity.kind === "restructure_toward"
      ? "This is a strategic target, not an immediate execution order; live prices, facility cost, and input supply must persist."
      : "Profitability can collapse if input prices rise, output depth disappears, or the production queue differs from the snapshot.",
    evidence: uniqueStrings([...opportunity.rationale, ...opportunity.blockers]).slice(0, 6),
    whyNow: opportunity.recommendation,
    bestWhen: opportunity.kind === "restructure_toward"
      ? "Use this when the global target remains profitable after checking building, research, inputs, and output liquidity."
      : "Use this when live prices still match the snapshot and the production facility/input coverage is still available.",
    avoidIf: opportunity.kind === "restructure_toward"
      ? "Avoid committing cash if setup gaps are unresolved or a nearer company-fit recipe has comparable profit."
      : "Avoid if the live exchange moved, inputs are no longer available, or output sell depth is too thin.",
    whatWouldChangeThis: "A fresh profitability pass with changed input/output prices can move this up, down, or out of the plan.",
    futureTriggers: [
      `${opportunity.title} still shows positive net profit by ${opportunity.horizonLabel}.`,
      "Input coverage, facility fit, and output liquidity remain valid in-game."
    ],
    preparedCommands: [profitabilityCommand(opportunity)]
  }, score, breakdown));
}

function addChainPlan(
  plans: ActionPlan[],
  opportunity: ChainOpportunity,
  context: PlayerPlanningContext,
  intent: PlanningIntent,
  urgentOperations: boolean
): void {
  const scoreCap = opportunity.kind === "restructure_chain"
    ? intent === "cv_growth" || intent === "market_profit" ? 70 : 56
    : 86;
  const urgency = opportunity.kind === "deepen_chain" ? 48 : opportunity.kind === "stage_chain" ? 36 : 22;
  const companyFit = opportunity.kind === "deepen_chain" ? 88 : opportunity.kind === "stage_chain" ? 70 : 38;
  const confidence = opportunity.confidence === "high" ? 88 : opportunity.confidence === "medium" ? 62 : 34;
  const breakdown = {
    urgency: urgentOperations ? Math.max(18, urgency - 14) : urgency,
    companyFit,
    profitPotential: clamp(opportunity.score),
    marketConfidence: confidence,
    feasibility: clamp(80 - opportunity.blockers.length * 10),
    goalAlignment: scoreGoalAlignment(context, intent, opportunity.title, "profitability")
  };
  const score = Math.min(weightedScore(breakdown), scoreCap);
  const id = `profit-chain-${opportunity.kind}-${opportunity.chainId}`;
  plans.push(withScore({
    id,
    title: opportunity.title,
    priority: priorityFromScore(score),
    category: "profitability",
    horizonId: opportunity.horizonId,
    horizonLabel: opportunity.horizonLabel,
    latestUsefulByHours: opportunity.horizonId === "d1" ? 24 : opportunity.horizonId === "d3" ? 72 : 168,
    profitPerHour: opportunity.profitPerHour,
    marginPct: opportunity.marginPct,
    profitabilityTag: opportunity.kind === "restructure_chain" ? "next feasible chain" : "company-fit chain",
    capitalFit: opportunity.capitalFit,
    setupDistance: opportunity.setupDistance,
    expectedBenefit: `${formatMoney(opportunity.profitPerHour)}/h estimated chain value${opportunity.marginPct !== undefined ? ` at ${formatPct(opportunity.marginPct)} margin` : ""}.`,
    costSummary: opportunity.blockers.length > 0 ? opportunity.blockers.join(" ") : "No major chain setup gap visible from the read-only snapshot.",
    risk: opportunity.kind === "restructure_chain"
      ? "This is a long-horizon chain target; setup gaps, input availability, and output liquidity must be rechecked across multiple snapshots."
      : "Chain profitability can collapse if any upstream input or downstream sell price moves before execution.",
    evidence: uniqueStrings([...opportunity.rationale, ...opportunity.blockers]).slice(0, 6),
    whyNow: opportunity.recommendation,
    bestWhen: opportunity.kind === "restructure_chain"
      ? "Use this when the chain beats current specialization after setup cost, input supply, and output liquidity checks."
      : "Use this when each linked recipe still shows positive margin and the current base setup can support the loop.",
    avoidIf: "Avoid if one upstream input is thin, a required building is unavailable, or the final output has weak demand.",
    whatWouldChangeThis: "Repeated snapshots showing weaker margins or unresolved setup gaps should demote this chain.",
    futureTriggers: [
      `${opportunity.title} remains profitable through ${opportunity.horizonLabel}.`,
      "Input coverage, facility fit, and final output liquidity remain valid."
    ],
    preparedCommands: [chainCommand(opportunity)]
  }, score, breakdown));
}

function addProjectedRestockPlans(
  plans: ActionPlan[],
  normalized: NormalizedSnapshot,
  marketSignals: MarketSignal[],
  stockoutRisks: StockoutRisk[],
  context: PlayerPlanningContext,
  intent: PlanningIntent,
  projectionBase: Pick<ProjectionSet, "horizons" | "materialNeeds">
): void {
  const immediateMatIds = new Set(stockoutRisks.map((risk) => risk.matId));
  const existingPlanIds = new Set(plans.map((plan) => plan.id));
  const projectedNeeds = projectionBase.materialNeeds
    .filter((need) => need.netNeedQty > 0 && need.hours > context.autonomyHours && !immediateMatIds.has(need.matId))
    .sort((a, b) => a.hours - b.hours || b.netNeedQty - a.netNeedQty);

  for (const need of projectedNeeds.slice(0, 6)) {
    const id = `project-restock-${need.matId}-${need.horizonId}`;
    if (existingPlanIds.has(id)) continue;
    const signal = marketSignals.find((item) => item.matId === need.matId);
    const currentPrice = signal?.currentPrice ?? 0;
    const cashImpactPct = normalized.cash > 0 && currentPrice > 0 ? ((currentPrice * need.netNeedQty) / normalized.cash) * 100 : 0;
    const baseScore = projectionNeedScore(need, cashImpactPct, context.cashRiskLevel);
    const breakdown = {
      urgency: clamp(75 - need.hours / 5),
      companyFit: 90,
      profitPotential: Math.max(10, signal?.recipeMarginPct ?? 10),
      marketConfidence: scoreMarketConfidence(signal),
      feasibility: scoreCashFeasibility(cashImpactPct, context.cashRiskLevel),
      goalAlignment: scoreGoalAlignment(context, intent, need.matName, "restock")
    };
    const score = Math.min(weightedScore(breakdown), baseScore);
    plans.push(withScore({
      id,
      title: `Prepare ${need.matName} coverage for ${need.horizonLabel}`,
      priority: priorityFromScore(score),
      category: "operations",
      horizonId: need.horizonId,
      horizonLabel: need.horizonLabel,
      latestUsefulByHours: need.hours,
      expectedBenefit: `Prevents a projected ${need.horizonLabel} shortage from becoming an urgent blocker.`,
      costSummary: `${Math.ceil(need.netNeedQty).toLocaleString()} projected net units${currentPrice > 0 ? `, about ${formatMoney(currentPrice * need.netNeedQty)}` : ""}.`,
      risk: "Longer-horizon demand assumes active production keeps repeating; verify live orders before buying.",
      evidence: [`${Math.ceil(need.requiredQty).toLocaleString()} projected required vs ${Math.ceil(need.availableQty).toLocaleString()} available by ${need.horizonLabel}.`],
      whyNow: `${need.matName} is covered near-term but projects short by ${need.horizonLabel}, so prepare the buy/production path now and execute only after live confirmation.`,
      bestWhen: `Use this when planning beyond ${context.autonomyHours} hours and the live production queue still matches the snapshot.`,
      avoidIf: "Avoid executing now if this would tie up cash before the shortage is confirmed in a fresh snapshot.",
      whatWouldChangeThis: "A new production order, completed output, or warehouse transfer can move this to a later horizon.",
      futureTriggers: [`Net need appears by ${need.horizonLabel}.`, "Live demand still matches the projected production loop."],
      preparedCommands: [buyCommand(`Prepare ${need.matName} coverage`, need.matId, Math.ceil(need.netNeedQty), need.matName)]
    }, score, breakdown));
    existingPlanIds.add(id);
  }
}

function computeExpansionCandidates(
  normalized: NormalizedSnapshot,
  risks: StockoutRisk[],
  context: PlayerPlanningContext,
  intent: PlanningIntent
): ExpansionCandidate[] {
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
    const title = intent === "cv_growth"
      ? "Prepare CV growth path before committing expansion"
      : intent === "expansion"
        ? "Prepare expansion path until bottlenecks surface"
        : "Keep expansion optional until bottlenecks surface";
    candidates.push({
      title,
      type: "base_plan",
      priority: "low",
      requiredMaterials: [],
      blockers: [],
      rationale: intent === "cv_growth"
        ? ["No urgent operational bottleneck is visible, so CV growth should be prepared by comparing deeper specialization against diversification before spending cash."]
        : ["No severe capacity or base-plan bottleneck was visible in the current read-only snapshot."],
      preparedCommands: [reviewCommand(intent === "cv_growth" ? "Review CV growth options" : "Review long-range expansion choices", {})]
    });
  }

  return candidates.slice(0, 10);
}

function computeSituation(
  normalized: NormalizedSnapshot,
  marketSignals: MarketSignal[],
  stockoutRisks: StockoutRisk[],
  logisticsMoves: LogisticsMove[],
  expansionCandidates: ExpansionCandidate[],
  profitability: ProfitabilitySet
): CompanySituation {
  const criticalRisks = stockoutRisks.filter((risk) => risk.severity === "critical").length;
  const highRisks = stockoutRisks.filter((risk) => risk.severity === "high").length;
  const warehouseMax = Math.max(0, ...normalized.warehouses.map((warehouse) => warehouse.utilization));
  const practicalProfitOptions = [...profitability.companyFit, ...(profitability.nextSteps ?? [])];
  const profitTop = Math.max(0, ...practicalProfitOptions.map((opportunity) => opportunity.score));
  const marketTop = Math.max(profitTop, ...marketSignals.map((signal) => Math.max(0, signal.recipeMarginPct ?? 0) + Math.abs(signal.spreadPct) + (signal.liquidityScore ?? 0) / 2));
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
    market: pressureSummary(clamp(marketTop), `${marketSignals.filter((signal) => signal.recommendation === "buy" || signal.recommendation === "sell").length} actionable market signals, ${profitability.companyFit.length} company-fit profit candidates, and ${(profitability.nextSteps ?? []).length} feasible next steps.`),
    expansion: pressureSummary(expansionCandidates.some((candidate) => candidate.priority === "high") ? 65 : 35, `${expansionCandidates.length} expansion/base-plan candidates.`),
    dataQuality: {
      ...pressureSummary(dataWarnings.length > 0 ? 55 : 10, dataWarnings.length > 0 ? `${dataWarnings.length} snapshot warnings; review raw data before major moves.` : "No snapshot warnings."),
      warnings: dataWarnings
    }
  };
}

function buildDecisionBrief(
  normalized: NormalizedSnapshot,
  situation: CompanySituation,
  marketSignals: MarketSignal[],
  stockoutRisks: StockoutRisk[],
  logisticsMoves: LogisticsMove[],
  expansionCandidates: ExpansionCandidate[],
  profitability: ProfitabilitySet,
  actionPlans: ActionPlan[],
  projections: ProjectionSet,
  context: PlayerPlanningContext,
  intent: PlanningIntent
): DecisionBrief {
  const topAction = actionPlans[0];
  const strongActions = actionPlans.filter((plan) => (plan.score ?? 0) >= 70 || plan.confidence === "high");
  const noStrongAction = strongActions.length === 0;
  const thesis = buildThesis(normalized, situation, topAction, profitability, context, intent, noStrongAction);
  const recommendedPath = buildRecommendedPath(actionPlans, projections, profitability, context, intent, noStrongAction);

  return {
    thesis,
    recommendedPath,
    whyThisPath: buildWhyThisPath(situation, marketSignals, stockoutRisks, logisticsMoves, expansionCandidates, profitability, projections, topAction, intent),
    alternatives: buildAlternatives(marketSignals, expansionCandidates, profitability, intent, noStrongAction),
    constraints: buildConstraints(situation, marketSignals, stockoutRisks, logisticsMoves, expansionCandidates, profitability),
    inspectNext: buildInspectNext(intent, actionPlans, marketSignals, expansionCandidates, profitability),
    confidence: decisionConfidence(situation, actionPlans, noStrongAction)
  };
}

function buildThesis(
  normalized: NormalizedSnapshot,
  situation: CompanySituation,
  topAction: ActionPlan | undefined,
  profitability: ProfitabilitySet,
  context: PlayerPlanningContext,
  intent: PlanningIntent,
  noStrongAction: boolean
): string {
  const company = normalized.companyName;
  const topProfit = profitability.companyFit[0];
  const topNextStep = profitability.nextSteps?.[0];
  const topAspirational = topAspirationalTarget(profitability);
  const topBlocked = topBlockedTarget(profitability);
  const topChain = practicalChainOpportunities(profitability)[0];
  if (intent === "cv_growth") {
    if (topProfit || topNextStep || topAspirational || topChain) {
      const immediate = topProfit ? `${topProfit.title} (${formatMoney(topProfit.profitPerHour)}/h)` : "no company-fit profit move";
      const next = topNextStep ? `${topNextStep.title} (${topNextStep.capitalFit ?? "unknown"} capital fit)` : topChain ? `${topChain.title} (${topChain.capitalFit ?? "unknown"} capital fit)` : "no affordable next-step target";
      const aspirational = topAspirational ? `${topAspirational.title} remains aspirational until ${topAspirational.firstPracticalStep ?? "its blockers are cleared"}` : "no separate aspirational target";
      return `${company}'s CV path should be company-feasible: use ${immediate} as the near-term proof point, evaluate ${next} next, and keep ${aspirational}.`;
    }
    if (topBlocked) {
      return `${company}'s CV path should stay grounded in current access and cash. ${topBlocked.title} is a blocked long-term reference, not a next move, until ${blockedReasonSummary(topBlocked)}.`;
    }
    if (noStrongAction) {
      return `${company} can work toward higher CV, but this snapshot does not justify a blind spend. Preserve cash, inspect the strongest current production lane, then choose deeper specialization or diversification only after a profitable chain is visible.`;
    }
    return `${company}'s best CV path is to execute ${topAction?.title ?? "the top ranked move"} first, then use the next inspection pass to decide whether capacity expansion or diversification has the better return.`;
  }
  if (intent === "market_profit") {
    if (topChain && topChain.kind !== "restructure_chain") return `${company}'s strongest profit angle is chain optimization: ${topChain.title}, estimated at ${formatMoney(topChain.profitPerHour)}/h across linked steps.`;
    if (topProfit) return `${company}'s best profit angle is ${topProfit.title}, estimated at ${formatMoney(topProfit.profitPerHour)}/h before omitted shipping/maintenance assumptions.`;
    if (topNextStep) return `${company}'s best realistic profit path is ${topNextStep.title}; it fits current capital better than the blocked global targets.`;
    return topAction?.category === "market"
      ? `${company}'s best near-term profit move is ${topAction.title}, with manual exchange checks before committing.`
      : `${company} does not show a strong market trade right now; protect operations first and only trade after confirming depth and spreads in-game.`;
  }
  if (intent === "production_stability") {
    return stockStatusThesis(company, situation, topAction, context);
  }
  if (intent === "logistics") {
    return topAction?.category === "logistics"
      ? `${company}'s logistics priority is ${topAction.title}; it uses owned material before new spending.`
      : `${company} has no urgent transfer in this snapshot, so inspect route/cargo state before moving ships.`;
  }
  if (intent === "expansion") {
    return noStrongAction
      ? `${company} should prepare expansion options, but current evidence favors waiting for a clearer bottleneck or material plan before spending.`
      : `${company}'s expansion path starts with ${topAction?.title ?? "the top ranked expansion review"} and should stay gated by cash and material checks.`;
  }
  if (intent === "risk_review") {
    return `${company}'s safest path is to avoid irreversible spending until the listed constraints are checked against live game state.`;
  }
  return stockStatusThesis(company, situation, topAction, context);
}

function stockStatusThesis(company: string, situation: CompanySituation, topAction: ActionPlan | undefined, context: PlayerPlanningContext): string {
  if (situation.production.status === "critical" || situation.production.status === "high") {
    return `${company}'s next ${context.autonomyHours} hours should focus on ${topAction?.title ?? "restocking production inputs"} before market or expansion work.`;
  }
  return `${company} is operationally stable in this snapshot; use the next check-in to prepare ${topAction?.title ?? "the highest-ranked review"} rather than forcing an urgent move.`;
}

function buildRecommendedPath(
  actionPlans: ActionPlan[],
  projections: ProjectionSet,
  profitability: ProfitabilitySet,
  context: PlayerPlanningContext,
  intent: PlanningIntent,
  noStrongAction: boolean
): string[] {
  const path = actionPlans.slice(0, 3).map((plan, index) => `${index + 1}. ${plan.horizonLabel ? `[${plan.horizonLabel}] ` : ""}${plan.title}: ${plan.whyNow ?? plan.expectedBenefit}`);
  if (intent === "cv_growth") {
    const topProfit = profitability.companyFit[0];
    const topNextStep = profitability.nextSteps?.[0];
    const topAspirational = topAspirationalTarget(profitability);
    const topBlocked = topBlockedTarget(profitability);
    const topChain = practicalChainOpportunities(profitability)[0];
    return [
      noStrongAction ? "1. Hold major spending until the Profitability tab identifies a real CV lever." : path[0] ?? "1. Execute the top ranked operational move first.",
      topProfit ? `2. Deepen current specialization only if ${topProfit.title} remains the near-term company-fit profit benchmark (${formatMoney(topProfit.profitPerHour)}/h).` : `2. Use the ${projections.horizons.map((horizon) => horizon.label).join(" / ")} timeline to separate blockers from CV prep.`,
      topNextStep ? `3. Evaluate the next feasible step ${topNextStep.title}; it is ${topNextStep.capitalFit ?? "unknown"} and should beat blocked global options before spending.` : topChain ? `3. Compare chain optimization using ${topChain.title}; advance only if all linked steps keep margin and coverage.` : "3. Compare deeper specialization against diversification using recipe profit, input availability, and facility requirements.",
      topAspirational
        ? `4. Keep ${topAspirational.title} as aspirational until ${topAspirational.firstPracticalStep ?? "capital and setup blockers are cleared"}.`
        : topBlocked
          ? "4. Keep blocked long-term references outside the plan; revisit them only after resource access, tech path, and known minimum capital are confirmed."
          : "4. Commit cash only to the option with clear throughput, market access, and material coverage before the relevant horizon."
    ];
  }
  if (path.length > 0) return path;
  return [
    "1. Recheck live game state before committing.",
    `2. Use the ${context.autonomyHours}-hour horizon to identify the first production, logistics, or market constraint.`,
    "3. Prepare manual actions only after the current screen confirms the snapshot."
  ];
}

function buildWhyThisPath(
  situation: CompanySituation,
  marketSignals: MarketSignal[],
  stockoutRisks: StockoutRisk[],
  logisticsMoves: LogisticsMove[],
  expansionCandidates: ExpansionCandidate[],
  profitability: ProfitabilitySet,
  projections: ProjectionSet,
  topAction: ActionPlan | undefined,
  intent: PlanningIntent
): string[] {
  const actionableMarkets = marketSignals.filter((signal) => signal.recommendation === "buy" || signal.recommendation === "sell").length;
  const projectedShortageBands = projections.bands.filter((band) => band.materialNeeds.length > 0).map((band) => band.horizonId);
  const topProfit = profitability.companyFit[0];
  const topNextStep = profitability.nextSteps?.[0];
  const topAspirational = topAspirationalTarget(profitability);
  const topBlocked = topBlockedTarget(profitability);
  const topChain = practicalChainOpportunities(profitability)[0];
  return uniqueStrings([
    topAction ? `${topAction.title} is ranked highest with score ${Math.round(topAction.score ?? 0)} and ${topAction.confidence ?? "unknown"} confidence.` : "No ranked action was strong enough to justify immediate execution.",
    `Production pressure is ${situation.production.status}: ${situation.production.summary}`,
    `Logistics pressure is ${situation.logistics.status}: ${situation.logistics.summary}`,
    `Market pressure is ${situation.market.status}: ${actionableMarkets} actionable signals survived company-fit filters.`,
    topProfit ? `Top company-fit profitability option is ${topProfit.title} at ${formatMoney(topProfit.profitPerHour)}/h.` : "No company-fit profitable production option cleared the current filters.",
    topNextStep ? `Top next feasible profit step is ${topNextStep.title} with ${topNextStep.capitalFit ?? "unknown"} capital fit.` : undefined,
    topChain ? `Best chain opportunity is ${topChain.title} at ${formatMoney(topChain.profitPerHour)}/h.` : undefined,
    topAspirational ? `Best aspirational target is ${topAspirational.title} at ${formatMoney(topAspirational.profitPerHour)}/h, but it is not a next action until blockers clear.` : undefined,
    topBlocked ? `${topBlocked.title} is excluded from action ranking because ${blockedReasonSummary(topBlocked)}.` : undefined,
    stockoutRisks.length > 0 ? `${stockoutRisks.length} stockout risks are visible in the planning window.` : "No stockout risk is visible in the current planning window.",
    projectedShortageBands.length > 0 ? `Longer-horizon material pressure appears in ${projectedShortageBands.length} projection band(s).` : "No projected material shortfall appears in the configured horizons.",
    logisticsMoves.length > 0 ? `${logisticsMoves.length} owned-material transfer options are feasible.` : "No owned-material transfer is currently needed.",
    intent === "cv_growth" ? `${expansionCandidates.length} expansion/base-plan options exist, but they should be gated by material requirements and expected throughput.` : undefined
  ]);
}

function buildAlternatives(
  marketSignals: MarketSignal[],
  expansionCandidates: ExpansionCandidate[],
  profitability: ProfitabilitySet,
  intent: PlanningIntent,
  noStrongAction: boolean
): DecisionBrief["alternatives"] {
  if (intent === "cv_growth" || intent === "expansion") {
    const topProfit = profitability.companyFit[0];
    const topNextStep = profitability.nextSteps?.[0];
    const topAspirational = topAspirationalTarget(profitability);
    const topBlocked = topBlockedTarget(profitability);
    const topChain = practicalChainOpportunities(profitability)[0];
    return [
      {
        title: topChain && topChain.kind !== "restructure_chain" ? `Deepen ${topChain.title.replace(/^Optimize /, "")}` : topProfit ? `Deepen ${topProfit.title.replace(/^Run profitable |^Stage inputs for /, "")}` : "Deepen current specialization",
        pros: [topChain ? `Chain estimate: ${formatMoney(topChain.profitPerHour)}/h.` : topProfit ? `Company-fit estimate: ${formatMoney(topProfit.profitPerHour)}/h.` : "Lower setup risk because it builds around known facilities and recipes.", "Usually improves CV through throughput once input coverage is proven."],
        cons: topChain?.blockers.length ? topChain.blockers : topProfit?.blockers.length ? topProfit.blockers : ["Can stall if the current chain lacks margin, contracts, or stable inputs."],
        chooseWhen: "Choose this when current recipe profit, input supply, and base capacity all support higher throughput."
      },
      {
        title: topNextStep ? `Take next feasible step: ${topNextStep.title}` : "Take the next affordable bridge step",
        pros: [topNextStep ? `${topNextStep.capitalFit ?? "unknown"} capital fit with ${formatMoney(topNextStep.profitPerHour)}/h estimate.` : "Moves toward better profit without jumping to an unreachable global optimum."],
        cons: topNextStep?.blockers.length ? topNextStep.blockers : ["Still requires live setup, input, and market validation."],
        chooseWhen: "Choose this when it stays inside the current cash-risk spend cap and improves the current production path."
      },
      {
        title: topAspirational
          ? `Track aspirational target ${topAspirational.title.replace(/^Restructure toward /, "")}`
          : topBlocked
            ? `Review blocked reference ${topBlocked.title.replace(/^Restructure toward /, "")}`
            : "Track aspirational global target",
        pros: [topAspirational ? `Aspirational estimate: ${formatMoney(topAspirational.profitPerHour)}/h.` : topBlocked ? "Can guide later research, planet/base access, and capital planning without becoming a current spend." : "Can guide future research and expansion choices."],
        cons: topAspirational?.blockers.length ? topAspirational.blockers : topBlocked ? uniqueStrings([...topBlocked.blockers, ...(topBlocked.blockingReasons ?? []), ...(topBlocked.unpricedRequirements ?? [])]).slice(0, 4) : ["Not feasible until cash, buildings, research, inputs, and market depth line up."],
        chooseWhen: topAspirational ? "Choose this later, not now, after the capital gap and setup blockers are removed." : "Use this as reference only after planet/resource access, tech path, and known minimum capital are confirmed."
      },
      {
        title: "Delay major expansion",
        pros: ["Preserves cash and avoids locking into a weak base plan."],
        cons: ["CV growth may be slower until a clearer bottleneck appears."],
        chooseWhen: noStrongAction ? "Choose this now if live checks do not reveal a profitable expansion target." : "Choose this if the top action fails its live in-game checks."
      }
    ];
  }

  const marketSignal = marketSignals.find((signal) => signal.recommendation === "buy" || signal.recommendation === "sell");
  return [
    {
      title: "Operational first",
      pros: ["Protects production and avoids cash traps."],
      cons: ["May miss short-lived market upside."],
      chooseWhen: "Choose this when stockout, logistics, or warehouse pressure is medium or higher."
    },
    {
      title: "Market opportunism",
      pros: marketSignal ? [`Current signal: ${marketSignal.matName} is marked ${marketSignal.recommendation}.`] : ["Can create upside when spreads and liquidity are favorable."],
      cons: ["Price depth can disappear before manual execution."],
      chooseWhen: "Choose this only when live exchange depth still matches the snapshot and the material fits company needs."
    }
  ];
}

function buildConstraints(
  situation: CompanySituation,
  marketSignals: MarketSignal[],
  stockoutRisks: StockoutRisk[],
  logisticsMoves: LogisticsMove[],
  expansionCandidates: ExpansionCandidate[],
  profitability: ProfitabilitySet
): string[] {
  const topBlocked = topBlockedTarget(profitability);
  return uniqueStrings([
    "GT Agent is read-only; every recommendation must be verified in-game before execution.",
    situation.cash.summary,
    stockoutRisks.length === 0 ? "No current stockout pressure means speculative moves need stronger proof." : undefined,
    logisticsMoves.length === 0 ? "No transfer candidate was found from owned inventory to current demand." : undefined,
    marketSignals.every((signal) => signal.recommendation !== "buy" && signal.recommendation !== "sell") ? "Market signals are watch-only after company-fit filters." : undefined,
    profitability.assumptions[1],
    topBlocked ? `${topBlocked.title} is blocked-reference only; known minimum capital is ${topBlocked.knownMinimumCapital !== undefined ? formatMoney(topBlocked.knownMinimumCapital) : "unknown"}, before unpriced gaps.` : undefined,
    topBlocked?.unpricedRequirements?.[0],
    profitability.warnings[0],
    expansionCandidates.every((candidate) => candidate.requiredMaterials.length === 0) ? "Expansion material requirements are not available in the read-only snapshot." : undefined,
    ...situation.dataQuality.warnings
  ]);
}

function buildInspectNext(
  intent: PlanningIntent,
  actionPlans: ActionPlan[],
  marketSignals: MarketSignal[],
  expansionCandidates: ExpansionCandidate[],
  profitability: ProfitabilitySet
): string[] {
  const topPlan = actionPlans[0];
  const topProfit = profitability.companyFit[0] ?? profitability.nextSteps?.[0] ?? topAspirationalTarget(profitability);
  const topBlocked = topBlockedTarget(profitability);
  const topChain = practicalChainOpportunities(profitability)[0];
  return uniqueStrings([
    topPlan ? `Open the screen for "${topPlan.title}" and verify the snapshot still matches live state.` : "Open the current production/base overview and confirm there are no hidden blockers.",
    "Refresh exchange depth and price before any buy/sell decision.",
    "Check warehouse free tonnes before moving or buying bulky materials.",
    topProfit ? `Open the Profitability tab and verify ${topProfit.title} against live input/output prices.` : "Use the Profitability tab to find a production lane before long-term restructuring.",
    topChain ? `Open the Chains view and verify every linked step in ${topChain.title}.` : undefined,
    topBlocked ? `Use Blocked long-term references to inspect ${topBlocked.title.replace(/^Restructure toward /, "")} only after planet/resource access, tech requirements, and known minimum capital are confirmed.` : undefined,
    intent === "cv_growth" ? "For CV growth, compare current specialization vs diversification by recipe margin, input availability, facility cost, and sell demand." : undefined,
    intent === "cv_growth" || intent === "expansion" ? "Open base plans and record required materials before committing expansion cash." : undefined,
    marketSignals[0] ? `Inspect ${marketSignals[0].matName} market depth because it is the strongest visible market signal.` : undefined,
    expansionCandidates[0] ? `Review ${expansionCandidates[0].title} and confirm whether it removes a real bottleneck.` : undefined
  ]);
}

function decisionConfidence(situation: CompanySituation, actionPlans: ActionPlan[], noStrongAction: boolean): DecisionBrief["confidence"] {
  if (situation.dataQuality.status === "high" || situation.dataQuality.status === "critical") return "low";
  if (!noStrongAction && actionPlans[0]?.confidence === "high") return "high";
  if (noStrongAction) return "medium";
  return actionPlans[0]?.confidence ?? "medium";
}

function practicalChainOpportunities(profitability: ProfitabilitySet): ChainOpportunity[] {
  return (profitability.chainOpportunities ?? []).filter((opportunity) => opportunity.capitalFit === "affordable" && (opportunity.blockingReasons ?? []).length === 0);
}

function topAspirationalTarget(profitability: ProfitabilitySet): ProfitabilityOpportunity | undefined {
  return profitability.aspirationalTargets?.find((opportunity) => (opportunity.blockingReasons ?? []).length === 0 && opportunity.capitalFit !== "blocked" && opportunity.capitalFit !== "unknown");
}

function topBlockedTarget(profitability: ProfitabilitySet): ProfitabilityOpportunity | undefined {
  return profitability.blockedTargets?.[0];
}

function blockedReasonSummary(opportunity: ProfitabilityOpportunity): string {
  const reasons = uniqueStrings([
    ...(opportunity.blockingReasons ?? []),
    ...(opportunity.unpricedRequirements ?? []),
    ...(opportunity.blockers ?? [])
  ]);
  if (reasons.length === 0) return "resource, tech, setup, and capital blockers are cleared";
  return reasons.slice(0, 2).join(" and ");
}

function uniqueStrings(items: Array<string | undefined>): string[] {
  return [...new Set(items.filter((item): item is string => Boolean(item && item.trim())))];
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
  if (signal.recommendation === "sell" && (signal.ownedQty ?? 0) > 0) return clamp(45 + scoreMarketMateriality(signal) * 0.5);
  if ((signal.recipeMarginPct ?? 0) >= 25 && prompt.includes(signal.matName.toLowerCase())) return 75;
  if ((signal.recipeMarginPct ?? 0) >= 25 && context.cashRiskLevel === "aggressive") return 55;
  return 20;
}

function scoreProfit(signal: MarketSignal): number {
  const spread = signal.recommendation === "sell" ? Math.max(0, signal.spreadPct) : Math.max(0, -signal.spreadPct);
  const materiality = signal.recommendation === "sell" ? scoreMarketMateriality(signal) : 0;
  return clamp(spread * 0.35 + materiality * 0.65 + Math.max(0, signal.recipeMarginPct ?? 0));
}

function scoreMarketMateriality(signal: MarketSignal): number {
  const pctScore = clamp((signal.materialityPct ?? 0) * 16);
  const grossScore = clamp((signal.grossCashImpactPct ?? 0) * 4);
  const absoluteScore = clamp(((signal.spreadValue ?? 0) / 100_000) * 60);
  return round(pctScore * 0.45 + grossScore * 0.25 + absoluteScore * 0.3);
}

function scoreMarketConfidence(signal: MarketSignal | undefined): number {
  if (!signal) return 35;
  return clamp((signal.liquidityScore ?? 25) * 0.7 + (signal.trendConfidence ?? 30) * 0.3 - (signal.volatilityPct ?? 0) * 0.7);
}

function scoreCashFeasibility(cashImpactPct: number, level: PlayerPlanningContext["cashRiskLevel"]): number {
  const limit = level === "conservative" ? 12 : level === "aggressive" ? 45 : 25;
  if (cashImpactPct <= 0) return 70;
  return clamp(100 - (cashImpactPct / limit) * 70);
}

function scoreGoalAlignment(context: PlayerPlanningContext, intent: PlanningIntent, label: string, category: string): number {
  const prompt = `${context.shortTermGoal} ${context.userPrompt ?? ""} ${context.notes ?? ""}`.toLowerCase();
  if (prompt.includes(label.toLowerCase())) return 100;
  if (intent === "cv_growth" && category === "expansion") return 90;
  if (intent === "cv_growth" && category === "profitability") return 95;
  if (intent === "cv_growth" && (category === "restock" || category === "sell")) return 75;
  if (intent === "market_profit" && category === "profitability") return 95;
  if (intent === "market_profit" && (category === "buy" || category === "sell")) return 90;
  if (intent === "production_stability" && category === "restock") return 90;
  if (intent === "logistics" && category === "logistics") return 95;
  if (intent === "risk_review") return 70;
  if (category === "restock" && /restock|production|input|short|bottleneck/.test(prompt)) return 85;
  if (category === "logistics" && /logistics|move|ship|cargo|transfer/.test(prompt)) return 85;
  if (category === "sell" && /market|sell|profit|price/.test(prompt)) return 80;
  if (category === "profitability" && /profit|margin|cv|value|production|recipe/.test(prompt)) return 88;
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

function profitabilityCommand(opportunity: ProfitabilityOpportunity): PreparedCommand {
  const reviewSteps = [
    "Open GT Companion or the in-game production view for the matching recipe.",
    "Refresh live input and output exchange prices.",
    "Confirm the facility, research, input coverage, warehouse room, and sell depth still match the snapshot."
  ];
  if (opportunity.kind === "run_now") {
    return {
      type: "start_production",
      title: `Validate production run for recipe ${opportunity.recipeId}`,
      executable: false,
      payload: { recipeId: opportunity.recipeId, opportunityId: opportunity.id },
      steps: [...reviewSteps, "Start production manually only if the net profit case still holds."]
    };
  }
  return {
    type: "review",
    title: `Review ${opportunity.title}`,
    executable: false,
    payload: { recipeId: opportunity.recipeId, opportunityId: opportunity.id, kind: opportunity.kind },
    steps: opportunity.blockers.length > 0
      ? [...reviewSteps, ...opportunity.blockers.map((blocker) => `Resolve: ${blocker}`)]
      : reviewSteps
  };
}

function chainCommand(opportunity: ChainOpportunity): PreparedCommand {
  return {
    type: "review",
    title: `Review ${opportunity.title}`,
    executable: false,
    payload: { chainId: opportunity.chainId, opportunityId: opportunity.id, kind: opportunity.kind },
    steps: [
      "Open the Profitability and production views for each linked recipe.",
      "Refresh live input and output exchange prices for every chain step.",
      "Confirm building access, research, input coverage, warehouse room, and final output depth.",
      ...opportunity.blockers.map((blocker) => `Resolve: ${blocker}`)
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
