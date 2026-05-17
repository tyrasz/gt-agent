import type {
  ActionPlan,
  DecisionPanel,
  DecisionPanelAction,
  DecisionRequirement,
  GameSnapshot,
  MarketSignal,
  PlayerPlanningContext,
  PreparedCommand
} from "../../shared/schemas.js";
import type { NormalizedSnapshot } from "./normalizers.js";
import { materialId, materialQuantity } from "./normalizers.js";
import { clamp, confidenceFromScore, formatMoney, formatPct, isRecord, numberValue, priorityFromScore, recordArray, round, text } from "./utils.js";

type PriceMap = Map<number, number>;

const CONTRACT_MATERIAL_KEYS = [
  "requirements",
  "requiredMaterials",
  "materials",
  "mats",
  "items",
  "inputs",
  "deliverables",
  "requested",
  "needed"
];

export function computeDecisionPanel(
  snapshot: GameSnapshot,
  normalized: NormalizedSnapshot,
  marketSignals: MarketSignal[],
  actionPlans: ActionPlan[],
  context: PlayerPlanningContext
): DecisionPanel {
  const prices = buildPriceMap(snapshot, normalized);
  const contractActions = snapshot.contracts
    .map((contract, index) => contractDecision(contract, index, normalized, prices, context))
    .filter((action): action is DecisionPanelAction => Boolean(action));
  const exchangeActions = exchangeDecisions(marketSignals, actionPlans, context);
  const actions = [...contractActions, ...exchangeActions]
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  let fallbackExchangeCount = 0;

  if (actions.length === 0) {
    const review = exchangeReviewFallback(marketSignals[0]);
    if (review) {
      actions.push(review);
      fallbackExchangeCount = 1;
    }
  }

  const visibleActions = actions.slice(0, 12);
  return {
    summary: decisionSummary(visibleActions, contractActions.length, exchangeActions.length + fallbackExchangeCount),
    actions: visibleActions,
    warnings: snapshot.contracts.length > 0 && contractActions.length === 0
      ? ["Contracts were present, but no current contract had enough material or payout data to rank above review level."]
      : []
  };
}

function contractDecision(
  contract: Record<string, unknown>,
  index: number,
  normalized: NormalizedSnapshot,
  prices: PriceMap,
  context: PlayerPlanningContext
): DecisionPanelAction | undefined {
  const status = contractStatus(contract);
  if (status && /(complete|completed|cancel|cancelled|failed|expired|done)/.test(status)) return undefined;

  const rawId = text(contract.id) ?? text(contract.contractId) ?? text(contract.cId) ?? numberValue(contract.id)?.toString() ?? numberValue(contract.contractId)?.toString();
  const id = `contract-${rawId ?? index + 1}`;
  const title = text(contract.title) ?? text(contract.name) ?? text(contract.contractName) ?? `Contract ${rawId ?? index + 1}`;
  const payout = contractPayout(contract);
  const deadline = contractDeadline(contract);
  const requirements = contractRequirements(contract, normalized, prices);
  const shortageCost = round(requirements.reduce((sum, requirement) => sum + (requirement.estimatedCost ?? 0), 0));
  const shortageCount = requirements.filter((requirement) => (requirement.shortageQty ?? 0) > 0).length;
  const cashImpactPct = normalized.cash > 0 && shortageCost > 0 ? round((shortageCost / normalized.cash) * 100) : undefined;
  const expectedValue = payout !== undefined ? round(payout - shortageCost) : undefined;
  const blockers = contractBlockers(requirements, payout, shortageCost, cashImpactPct, expectedValue, context);
  const action = contractAction(requirements, payout, expectedValue, shortageCount);
  const score = contractScore(action, payout, expectedValue, cashImpactPct, requirements, deadline, context);
  const confidence = contractConfidence(requirements, payout, shortageCost, expectedValue);

  return {
    id,
    kind: "contract",
    action,
    title: contractTitle(action, title),
    priority: priorityFromScore(score),
    score,
    confidence,
    expectedValue,
    cashImpactPct,
    deadline,
    requirements,
    blockers,
    evidence: contractEvidence(title, payout, expectedValue, shortageCost, requirements, deadline, status),
    preparedCommands: contractCommands(action, title, requirements, payout, expectedValue)
  };
}

function exchangeDecisions(
  marketSignals: MarketSignal[],
  actionPlans: ActionPlan[],
  context: PlayerPlanningContext
): DecisionPanelAction[] {
  const marketPlanByMatId = new Map<number, ActionPlan>();
  for (const plan of actionPlans.filter((item) => item.category === "market")) {
    const matId = numberValue(plan.id.replace(/^market-/, ""));
    if (matId) marketPlanByMatId.set(matId, plan);
  }

  return marketSignals
    .filter((signal) => signal.recommendation === "buy" || signal.recommendation === "sell")
    .map((signal) => exchangeDecision(signal, marketPlanByMatId.get(signal.matId), context))
    .filter((action): action is DecisionPanelAction => Boolean(action))
    .slice(0, 8);
}

function exchangeDecision(
  signal: MarketSignal,
  plan: ActionPlan | undefined,
  context: PlayerPlanningContext
): DecisionPanelAction | undefined {
  const buy = signal.recommendation === "buy";
  const quantity = Math.ceil(buy ? signal.netNeedQty || 1 : signal.ownedQty ?? 0);
  if (!buy && quantity <= 0) return undefined;

  const priceDelta = buy
    ? Math.max(0, signal.avgPrice - signal.currentPrice)
    : Math.max(0, signal.currentPrice - signal.avgPrice);
  const expectedValue = priceDelta > 0 ? round(priceDelta * quantity) : undefined;
  const cashImpactPct = buy ? signal.cashImpactPct : signal.materialityPct;
  const score = plan?.score ?? exchangeScore(signal, context);
  const blockers = exchangeBlockers(signal, quantity, context);
  const requirements: DecisionRequirement[] = [{
    matId: signal.matId,
    matName: signal.matName,
    quantity,
    availableQty: buy ? signal.ownedQty : signal.ownedQty,
    shortageQty: buy ? signal.netNeedQty : 0,
    estimatedCost: buy && signal.currentPrice > 0 ? round(signal.currentPrice * quantity) : undefined
  }];

  return {
    id: `exchange-${signal.recommendation}-${signal.matId}`,
    kind: "exchange",
    action: buy ? "buy_material" : "adjust_sell_offer",
    title: `${buy ? "Buy" : "Reprice"} ${signal.matName}`,
    priority: plan?.priority ?? priorityFromScore(score),
    score,
    confidence: plan?.confidence ?? confidenceFromScore((signal.liquidityScore ?? 25) * 0.6 + (signal.trendConfidence ?? 30) * 0.4),
    expectedValue,
    cashImpactPct,
    requirements,
    blockers,
    evidence: [
      ...signal.rationale.slice(0, 4),
      plan?.whyNow,
      buy ? `Cash impact is ${cashImpactPct !== undefined ? formatPct(cashImpactPct) : "unknown"}.` : `${quantity.toLocaleString()} units are visible for repricing with about ${formatMoney(expectedValue ?? 0)} premium value${cashImpactPct !== undefined ? ` (${formatPct(cashImpactPct)} of cash)` : ""}.`
    ].filter((item): item is string => Boolean(item)),
    preparedCommands: plan?.preparedCommands.length ? plan.preparedCommands : [exchangeCommand(signal, quantity)]
  };
}

function exchangeReviewFallback(signal: MarketSignal | undefined): DecisionPanelAction | undefined {
  if (!signal) return undefined;
  return {
    id: `exchange-review-${signal.matId}`,
    kind: "exchange",
    action: "review_exchange",
    title: `Review ${signal.matName} exchange depth`,
    priority: "low",
    score: 24,
    confidence: "low",
    requirements: [],
    blockers: ["No buy, sell, or reprice action cleared the company-fit filters."],
    evidence: signal.rationale.slice(0, 4),
    preparedCommands: [{
      type: "review",
      title: `Review ${signal.matName} exchange depth`,
      executable: false,
      payload: { matId: signal.matId },
      steps: [`Open ${signal.matName} on the Galactic Exchange.`, "Refresh live price and depth.", "Wait unless a real need, owned inventory, or profitable spread appears."]
    }]
  };
}

function contractRequirements(contract: Record<string, unknown>, normalized: NormalizedSnapshot, prices: PriceMap): DecisionRequirement[] {
  const records = CONTRACT_MATERIAL_KEYS.flatMap((key) => materialRecords(contract[key], 0));
  const byMatId = new Map<number, DecisionRequirement>();

  for (const record of records) {
    const nestedMaterial = isRecord(record.material) ? record.material : undefined;
    const matId = materialId(record) ?? materialId(nestedMaterial ?? {}) ?? numberValue(record.materialId) ?? numberValue(record.mat);
    const quantity = materialQuantity(record) || numberValue(record.amount) || numberValue(record.count) || numberValue(record.requiredQty) || 0;
    if (!matId || quantity <= 0) continue;
    const material = normalized.materials.get(matId);
    const matName = text(record.matName) ?? text(record.materialName) ?? text(record.name) ?? text(nestedMaterial?.name) ?? material?.name ?? `Material ${matId}`;
    const availableQty = normalized.inventory.get(matId)?.totalQty ?? 0;
    const shortageQty = Math.max(0, round(quantity - availableQty));
    const price = prices.get(matId);
    const existing = byMatId.get(matId);
    const nextQuantity = (existing?.quantity ?? 0) + quantity;
    const nextShortage = Math.max(0, round(nextQuantity - availableQty));
    byMatId.set(matId, {
      matId,
      matName,
      quantity: round(nextQuantity),
      availableQty: round(availableQty),
      shortageQty: nextShortage,
      estimatedCost: price && nextShortage > 0 ? round(price * nextShortage) : existing?.estimatedCost
    });
  }

  return [...byMatId.values()].sort((a, b) => (b.shortageQty ?? 0) - (a.shortageQty ?? 0) || a.matName.localeCompare(b.matName));
}

function materialRecords(value: unknown, depth: number): Record<string, unknown>[] {
  if (depth > 3) return [];
  if (Array.isArray(value)) return value.flatMap((item) => materialRecords(item, depth + 1));
  if (!isRecord(value)) return [];
  if (materialId(value) || numberValue(value.materialId) || numberValue(value.mat)) return [value];
  return CONTRACT_MATERIAL_KEYS.flatMap((key) => materialRecords(value[key], depth + 1));
}

function contractPayout(contract: Record<string, unknown>): number | undefined {
  for (const key of ["payout", "reward", "payment", "cash", "money", "value", "totalReward", "totalPayout", "price", "amount"]) {
    const direct = numberValue(contract[key]);
    if (direct !== undefined) return direct;
    if (isRecord(contract[key])) {
      const nested = contract[key];
      const value = numberValue(nested.cash) ?? numberValue(nested.money) ?? numberValue(nested.amount) ?? numberValue(nested.value) ?? numberValue(nested.payout);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

function contractDeadline(contract: Record<string, unknown>): string | undefined {
  for (const key of ["deadline", "expiresAt", "expiration", "dueAt", "due", "endsAt", "endAt", "expires", "completeBy"]) {
    const value = contract[key];
    const asText = text(value);
    if (asText) return asText;
    const asNumber = numberValue(value);
    if (asNumber !== undefined) {
      if (asNumber > 1_000_000_000_000) return new Date(asNumber).toISOString();
      if (asNumber > 1_000_000_000) return new Date(asNumber * 1000).toISOString();
      return String(asNumber);
    }
  }
  return undefined;
}

function contractStatus(contract: Record<string, unknown>): string | undefined {
  return text(contract.status)?.toLowerCase() ?? text(contract.state)?.toLowerCase() ?? text(contract.contractStatus)?.toLowerCase();
}

function contractBlockers(
  requirements: DecisionRequirement[],
  payout: number | undefined,
  shortageCost: number,
  cashImpactPct: number | undefined,
  expectedValue: number | undefined,
  context: PlayerPlanningContext
): string[] {
  const blockers: string[] = [];
  if (requirements.length === 0) blockers.push("Contract material requirements were not found in the snapshot.");
  if (payout === undefined) blockers.push("Contract cash payout was not found in the snapshot.");
  for (const requirement of requirements.filter((item) => (item.shortageQty ?? 0) > 0).slice(0, 4)) {
    blockers.push(`Need ${Math.ceil(requirement.shortageQty ?? 0).toLocaleString()} ${requirement.matName} before fulfillment.`);
  }
  const limit = cashRiskLimit(context.cashRiskLevel);
  if (cashImpactPct !== undefined && cashImpactPct > limit) {
    blockers.push(`Shortage buy cost ${formatMoney(shortageCost)} is ${formatPct(cashImpactPct)}, above the ${context.cashRiskLevel} cash-risk gate of ${formatPct(limit)}.`);
  }
  if (expectedValue !== undefined && expectedValue <= 0) blockers.push("Visible payout does not cover estimated exchange shortage cost.");
  return blockers;
}

function contractAction(
  requirements: DecisionRequirement[],
  payout: number | undefined,
  expectedValue: number | undefined,
  shortageCount: number
): DecisionPanelAction["action"] {
  if (requirements.length === 0 || payout === undefined) return "review_contract";
  if (expectedValue !== undefined && expectedValue <= 0) return "skip_contract";
  if (shortageCount === 0) return "fulfill_contract";
  return "prepare_contract";
}

function contractScore(
  action: DecisionPanelAction["action"],
  payout: number | undefined,
  expectedValue: number | undefined,
  cashImpactPct: number | undefined,
  requirements: DecisionRequirement[],
  deadline: string | undefined,
  context: PlayerPlanningContext
): number {
  const dataScore = payout !== undefined && requirements.length > 0 ? 92 : requirements.length > 0 || payout !== undefined ? 45 : 20;
  const shortageCost = requirements.reduce((sum, item) => sum + (item.estimatedCost ?? 0), 0);
  const shortageCount = requirements.filter((item) => (item.shortageQty ?? 0) > 0).length;
  const valueScore = expectedValue === undefined || payout === undefined
    ? 35
    : expectedValue <= 0 ? 5 : clamp((expectedValue / Math.max(1, payout)) * 100);
  const riskLimit = cashRiskLimit(context.cashRiskLevel);
  const feasibility = shortageCount === 0
    ? 96
    : cashImpactPct === undefined ? 48
      : cashImpactPct <= riskLimit ? 70
        : 24;
  const urgency = deadlineUrgency(deadline);
  const actionBias = action === "fulfill_contract" ? 12 : action === "prepare_contract" ? 0 : action === "review_contract" ? -16 : -24;
  const score = dataScore * 0.18 + valueScore * 0.32 + feasibility * 0.32 + urgency * 0.18 + actionBias - (shortageCost <= 0 ? 0 : 2);
  return round(clamp(score));
}

function contractConfidence(
  requirements: DecisionRequirement[],
  payout: number | undefined,
  shortageCost: number,
  expectedValue: number | undefined
): DecisionPanelAction["confidence"] {
  if (requirements.length === 0 || payout === undefined) return "low";
  if (expectedValue !== undefined && expectedValue <= 0) return "high";
  if (shortageCost > 0 && requirements.some((item) => item.estimatedCost === undefined)) return "medium";
  return "high";
}

function deadlineUrgency(deadline: string | undefined): number {
  if (!deadline) return 42;
  const timestamp = Date.parse(deadline);
  if (!Number.isFinite(timestamp)) return 45;
  const hours = (timestamp - Date.now()) / (60 * 60 * 1000);
  if (hours <= 0) return 5;
  if (hours <= 12) return 90;
  if (hours <= 24) return 78;
  if (hours <= 72) return 62;
  return 42;
}

function contractTitle(action: DecisionPanelAction["action"], title: string): string {
  if (action === "fulfill_contract") return `Fulfill ${title}`;
  if (action === "prepare_contract") return `Prepare ${title}`;
  if (action === "skip_contract") return `Skip ${title}`;
  return `Review ${title}`;
}

function contractEvidence(
  title: string,
  payout: number | undefined,
  expectedValue: number | undefined,
  shortageCost: number,
  requirements: DecisionRequirement[],
  deadline: string | undefined,
  status: string | undefined
): string[] {
  return [
    payout !== undefined ? `Payout: ${formatMoney(payout)}.` : "Payout was not parsed from the contract payload.",
    expectedValue !== undefined ? `Estimated value after visible shortage buys: ${formatMoney(expectedValue)}.` : undefined,
    shortageCost > 0 ? `Estimated shortage buy cost: ${formatMoney(shortageCost)}.` : "Visible inventory covers parsed requirements.",
    requirements.length > 0 ? `${requirements.length} material requirement group(s) parsed for ${title}.` : "No material requirement group could be parsed.",
    deadline ? `Deadline: ${deadline}.` : undefined,
    status ? `Status: ${status}.` : undefined
  ].filter((item): item is string => Boolean(item));
}

function contractCommands(
  action: DecisionPanelAction["action"],
  title: string,
  requirements: DecisionRequirement[],
  payout: number | undefined,
  expectedValue: number | undefined
): PreparedCommand[] {
  const review: PreparedCommand = {
    type: "review",
    title: `Review contract: ${title}`,
    executable: false,
    payload: { title, payout, expectedValue },
    steps: [
      `Open contract "${title}" in Galactic Tycoons.`,
      "Confirm payout, deadline, and required materials against live state.",
      action === "skip_contract" ? "Do not fulfill unless live payout or material cost has changed." : "Apply the manual contract action only if the live screen still matches this snapshot."
    ]
  };
  const buyCommands = requirements
    .filter((requirement) => (requirement.shortageQty ?? 0) > 0)
    .slice(0, 3)
    .map((requirement): PreparedCommand => ({
      type: "buy_material",
      title: `Stage ${requirement.matName} for ${title}`,
      executable: false,
      payload: { matId: requirement.matId, quantity: Math.ceil(requirement.shortageQty ?? 0), contractTitle: title },
      steps: [
        `Open ${requirement.matName} on the Galactic Exchange.`,
        `Confirm at least ${Math.ceil(requirement.shortageQty ?? 0).toLocaleString()} units are available near the snapshot price.`,
        "Buy only if the contract payout still covers the staged material cost."
      ]
    }));
  return action === "prepare_contract" ? [review, ...buyCommands] : [review];
}

function exchangeBlockers(signal: MarketSignal, quantity: number, context: PlayerPlanningContext): string[] {
  const blockers: string[] = [];
  const limit = cashRiskLimit(context.cashRiskLevel);
  if (signal.recommendation === "buy" && signal.cashImpactPct !== undefined && signal.cashImpactPct > limit) {
    blockers.push(`Buy would use ${formatPct(signal.cashImpactPct)} of visible cash, above the ${context.cashRiskLevel} gate of ${formatPct(limit)}.`);
  }
  if (signal.recommendation === "sell" && quantity <= 0) blockers.push("No owned or listed quantity was visible for repricing.");
  if ((signal.volatilityPct ?? 0) > 25) blockers.push("High price volatility; refresh live exchange depth before committing.");
  return blockers;
}

function exchangeScore(signal: MarketSignal, context: PlayerPlanningContext): number {
  const fit = signal.recommendation === "sell" ? clamp(50 + marketMaterialityScore(signal) * 0.35) : (signal.netNeedQty ?? 0) > 0 ? 82 : 45;
  const spread = signal.recommendation === "buy" ? Math.max(0, -signal.spreadPct) : Math.max(0, signal.spreadPct);
  const cash = signal.recommendation === "buy" && signal.cashImpactPct !== undefined
    ? signal.cashImpactPct <= cashRiskLimit(context.cashRiskLevel) ? 80 : 25
    : signal.recommendation === "sell" ? marketMaterialityScore(signal) : 75;
  return round(clamp(fit * 0.34 + spread * 0.16 + (signal.liquidityScore ?? 25) * 0.2 + cash * 0.22 + (signal.trendConfidence ?? 30) * 0.08));
}

function marketMaterialityScore(signal: MarketSignal): number {
  const pctScore = clamp((signal.materialityPct ?? 0) * 16);
  const grossScore = clamp((signal.grossCashImpactPct ?? 0) * 4);
  const absoluteScore = clamp(((signal.spreadValue ?? 0) / 100_000) * 60);
  return round(pctScore * 0.45 + grossScore * 0.25 + absoluteScore * 0.3);
}

function exchangeCommand(signal: MarketSignal, quantity: number): PreparedCommand {
  if (signal.recommendation === "buy") {
    return {
      type: "buy_material",
      title: `Check buy quantity for ${signal.matName}`,
      executable: false,
      payload: { matId: signal.matId, quantity },
      steps: [
        `Open ${signal.matName} on the Galactic Exchange.`,
        `Check whether at least ${quantity.toLocaleString()} units are still available near the snapshot price.`,
        "Buy only the quantity that still matches current demand and cash-risk settings."
      ]
    };
  }
  return {
    type: "adjust_sell_offer",
    title: `Review sell offer for ${signal.matName}`,
    executable: false,
    payload: { matId: signal.matId, currentPrice: signal.currentPrice, avgPrice: signal.avgPrice, ownedQty: signal.ownedQty },
    steps: [
      `Open ${signal.matName} on the Galactic Exchange.`,
      "Compare visible cheapest orders against this snapshot.",
      "Adjust only sell quantity you actually own or already listed."
    ]
  };
}

function buildPriceMap(snapshot: GameSnapshot, normalized: NormalizedSnapshot): PriceMap {
  const prices = new Map<number, number>();
  for (const item of [...snapshot.market.prices, ...snapshot.market.details]) {
    const matId = numberValue(item.matId) ?? numberValue(item.id);
    const price = numberValue(item.currentPrice);
    if (matId && price && price > 0) prices.set(matId, price);
  }
  for (const material of normalized.materials.values()) {
    if (!prices.has(material.id) && material.cp && material.cp > 0) prices.set(material.id, material.cp);
  }
  return prices;
}

function cashRiskLimit(level: PlayerPlanningContext["cashRiskLevel"]): number {
  if (level === "conservative") return 12;
  if (level === "aggressive") return 45;
  return 25;
}

function decisionSummary(actions: DecisionPanelAction[], contractCount: number, exchangeCount: number): string {
  const top = actions[0];
  if (!top) return "No contract or exchange decision cleared the current filters.";
  return `${actions.length} contract/exchange decision${actions.length === 1 ? "" : "s"} ranked (${contractCount} contract, ${exchangeCount} exchange), led by ${top.title}.`;
}
