import type {
  BufferMaterial,
  GameSnapshot,
  MarketSignal,
  OperationsBrief,
  OperationsIncomeLine,
  OperationsProblem,
  PlayerPlanningContext,
  ProfitabilitySet,
  SurplusPlan
} from "../../shared/schemas.js";
import type { InventoryPosition, NormalizedSnapshot } from "./normalizers.js";
import { materialId, materialQuantity } from "./normalizers.js";
import { formatMoney, formatPct, numberValue, recordArray, round, text } from "./utils.js";

type PriceInfo = {
  value?: number;
  source: "market" | "cp" | "missing";
  matName: string;
};

type ActiveRecipeOrder = {
  id: string;
  baseName: string;
  recipeId: number;
  orderCount: number;
  recipe: Record<string, unknown>;
};

const INCOME_HORIZON_HOURS = 12;
const DEFAULT_BUFFER_HOURS = 8;

export function operationsBufferHours(context: PlayerPlanningContext): number {
  return Math.max(1, Math.min(168, context.bufferHours ?? DEFAULT_BUFFER_HOURS));
}

export function computeOperationsBrief(
  snapshot: GameSnapshot,
  normalized: NormalizedSnapshot,
  profitability: ProfitabilitySet,
  marketSignals: MarketSignal[],
  context: PlayerPlanningContext
): OperationsBrief {
  const prices = buildPriceMap(snapshot, normalized);
  const activeOrders = activeRecipeOrders(snapshot);
  const expectedIncome = expectedIncomeForActiveProduction(activeOrders, normalized, profitability, prices);
  const bufferPlan = buildBufferPlan(normalized, prices, context);
  const surplusPlans = buildSurplusPlans(normalized, marketSignals, profitability, prices, context);
  const problems = buildProblems(normalized, expectedIncome.lines, bufferPlan.materials, context);

  return {
    expectedIncome,
    problems,
    bufferPlan,
    surplusPlans
  };
}

function expectedIncomeForActiveProduction(
  activeOrders: ActiveRecipeOrder[],
  normalized: NormalizedSnapshot,
  profitability: ProfitabilitySet,
  prices: Map<number, PriceInfo>
): OperationsBrief["expectedIncome"] {
  const profitabilityByRecipe = new Map(profitability.recipes.map((recipe) => [recipe.recipeId, recipe]));
  const lines = activeOrders.map((order) => {
    const output = recordValue(order.recipe.output);
    const outputMatId = output ? materialId(output) : undefined;
    const outputMat = outputMatId ? normalized.materials.get(outputMatId) : undefined;
    const outputAmount = output ? materialQuantity(output) || 1 : 1;
    const recipeName = text(order.recipe.name) || `${outputMat?.name ?? `Recipe ${order.recipeId}`} recipe`;
    const timeMinutes = Math.max(1, numberValue(order.recipe.timeMinutes) ?? numberValue(order.recipe.minutes) ?? 60);
    const cycles = (INCOME_HORIZON_HOURS * 60 / timeMinutes) * order.orderCount;
    const outputPrice = outputMatId ? priceFor(outputMatId, prices, outputMat?.name) : missingPrice("unknown output");
    const inputPrices: string[] = [];
    let missingPrices = outputPrice.source === "missing" ? 1 : 0;
    let fallbackPrices = outputPrice.source === "cp" ? 1 : 0;
    let inputCost = 0;

    for (const input of recordArray(order.recipe.inputs)) {
      const inputMatId = materialId(input);
      const amount = materialQuantity(input);
      if (!inputMatId || amount <= 0) continue;
      const inputMat = normalized.materials.get(inputMatId);
      const price = priceFor(inputMatId, prices, inputMat?.name);
      inputPrices.push(`${inputMat?.name ?? `Material ${inputMatId}`}: ${price.source}`);
      if (price.value === undefined) {
        missingPrices += 1;
        continue;
      }
      if (price.source === "cp") fallbackPrices += 1;
      inputCost += price.value * amount * cycles;
    }

    const grossOutputValue = outputPrice.value !== undefined ? outputPrice.value * outputAmount * cycles : 0;
    const workerConsumableCostPerHour = profitabilityByRecipe.get(order.recipeId)?.workerConsumableCostPerHour;
    const workerConsumableCost = workerConsumableCostPerHour !== undefined
      ? workerConsumableCostPerHour * INCOME_HORIZON_HOURS * order.orderCount
      : undefined;
    const netProfit = grossOutputValue - inputCost - (workerConsumableCost ?? 0);
    const confidence: OperationsIncomeLine["confidence"] = missingPrices > 0 ? "low" : fallbackPrices > 0 ? "medium" : "high";
    const marginPct = inputCost > 0 ? round((netProfit / inputCost) * 100) : undefined;

    return {
      id: `income-${order.recipeId}-${slug(order.baseName)}`,
      baseName: order.baseName,
      recipeId: order.recipeId,
      recipeName,
      orderCount: order.orderCount,
      outputMatId: outputMatId ?? 0,
      outputMatName: outputMat?.name ?? outputPrice.matName,
      grossOutputValue: round(grossOutputValue),
      inputCost: round(inputCost),
      workerConsumableCost: workerConsumableCost !== undefined ? round(workerConsumableCost) : undefined,
      netProfit: round(netProfit),
      marginPct,
      confidence,
      priceSources: uniqueStrings([`${outputMat?.name ?? outputPrice.matName}: ${outputPrice.source}`, ...inputPrices]),
      assumptions: [
        `${order.orderCount} active production order(s) at ${order.baseName}.`,
        `${Math.round(cycles * 100) / 100} recipe cycle(s) projected over ${INCOME_HORIZON_HOURS}h.`
      ]
    } satisfies OperationsIncomeLine;
  });

  const grossOutputValue = round(lines.reduce((sum, line) => sum + line.grossOutputValue, 0));
  const inputCost = round(lines.reduce((sum, line) => sum + line.inputCost, 0));
  const workerCostSum = lines.reduce((sum, line) => sum + (line.workerConsumableCost ?? 0), 0);
  const workerConsumableCost = workerCostSum > 0 ? round(workerCostSum) : undefined;
  const netProfit = round(lines.reduce((sum, line) => sum + line.netProfit, 0));
  const confidence: OperationsBrief["expectedIncome"]["confidence"] = lines.some((line) => line.confidence === "low")
    ? "low"
    : lines.some((line) => line.confidence === "medium")
      ? "medium"
      : "high";

  return {
    horizonHours: INCOME_HORIZON_HOURS,
    grossOutputValue,
    inputCost,
    workerConsumableCost,
    netProfit,
    confidence: lines.length > 0 ? confidence : "low",
    assumptions: uniqueStrings([
      "Forecast assumes visible active production orders keep running for the next 12 hours.",
      "Prices use current market values first and material CP fallback second.",
      workerConsumableCost !== undefined ? "Worker consumables are included where parsed from game data." : "Worker consumables are omitted when no parsed consumable cost is available.",
      lines.length === 0 ? "No active production orders were visible in the company snapshot." : undefined
    ]),
    lines: lines.sort((a, b) => b.netProfit - a.netProfit)
  };
}

function buildBufferPlan(
  normalized: NormalizedSnapshot,
  prices: Map<number, PriceInfo>,
  context: PlayerPlanningContext
): OperationsBrief["bufferPlan"] {
  const targetHours = operationsBufferHours(context);
  const materials: BufferMaterial[] = [];
  const warnings: string[] = [];

  for (const demand of normalized.demand.values()) {
    if (demand.productionQtyPer12h <= 0) continue;
    const burnPerHour = demand.productionQtyPer12h / 12;
    const inventory = normalized.inventory.get(demand.matId);
    const ownedQty = inventory?.totalQty ?? 0;
    const targetQty = burnPerHour * targetHours;
    const buyQty = Math.max(0, targetQty - ownedQty);
    const coverageHours = burnPerHour > 0 ? ownedQty / burnPerHour : undefined;
    const material = normalized.materials.get(demand.matId);
    const price = priceFor(demand.matId, prices, material?.name ?? demand.matName);
    const estimatedCost = price.value !== undefined ? round(buyQty * price.value) : undefined;
    if (buyQty > 0 && estimatedCost === undefined) warnings.push(`${demand.matName} buffer fill cost is unavailable because no market or CP price was found.`);

    materials.push({
      matId: demand.matId,
      matName: demand.matName,
      targetHours,
      coverageHours: coverageHours !== undefined ? round(coverageHours) : undefined,
      targetQty: round(targetQty),
      ownedQty: round(ownedQty),
      buyQty: round(buyQty),
      estimatedCost,
      priceSource: price.source,
      urgency: bufferUrgency(coverageHours, targetHours),
      affectedBases: demand.affectedBases
    });
  }

  return {
    targetHours,
    totalFillCost: round(materials.reduce((sum, material) => sum + (material.estimatedCost ?? 0), 0)),
    materials: materials.sort((a, b) => b.buyQty - a.buyQty || (a.coverageHours ?? 999) - (b.coverageHours ?? 999)).slice(0, 16),
    warnings
  };
}

function buildSurplusPlans(
  normalized: NormalizedSnapshot,
  marketSignals: MarketSignal[],
  profitability: ProfitabilitySet,
  prices: Map<number, PriceInfo>,
  context: PlayerPlanningContext
): SurplusPlan[] {
  const targetHours = operationsBufferHours(context);
  const marketByMat = new Map(marketSignals.map((signal) => [signal.matId, signal]));
  const profitableInputMatIds = new Set(
    [...profitability.companyFit, ...(profitability.nextSteps ?? [])]
      .flatMap((opportunity) => profitability.recipes.find((recipe) => recipe.recipeId === opportunity.recipeId)?.inputMatIds ?? [])
  );
  const threshold = surplusActionThreshold(normalized.cash);
  const plans: SurplusPlan[] = [];

  for (const inventory of normalized.inventory.values()) {
    const demand = normalized.demand.get(inventory.matId);
    const burnPerHour = demand ? demand.productionQtyPer12h / 12 : 0;
    const protectedQty = (demand?.wishlistQty ?? 0) + burnPerHour * targetHours;
    const surplusQty = round(Math.max(0, inventory.totalQty - protectedQty));
    if (surplusQty <= 0) continue;
    const material = normalized.materials.get(inventory.matId);
    const price = priceFor(inventory.matId, prices, material?.name ?? inventory.matName);
    const surplusValue = price.value !== undefined ? round(surplusQty * price.value) : undefined;
    const market = marketByMat.get(inventory.matId);
    const meaningfulValue = (surplusValue ?? 0) >= threshold;
    const recommendation = surplusRecommendation({ inventory, market, profitableInputMatIds, meaningfulValue });
    const confidence: SurplusPlan["confidence"] = price.source === "market" && meaningfulValue
      ? "high"
      : price.source === "missing"
        ? "low"
        : "medium";
    const actionId = (recommendation === "sell" || recommendation === "reprice") && meaningfulValue
      ? `surplus-${inventory.matId}`
      : undefined;
    const plan: SurplusPlan = {
      matId: inventory.matId,
      matName: inventory.matName,
      surplusQty,
      priceSource: price.source,
      recommendation,
      confidence,
      reason: surplusReason(recommendation, surplusQty, surplusValue, threshold, market, profitableInputMatIds.has(inventory.matId))
    };
    if (surplusValue !== undefined) plan.surplusValue = surplusValue;
    if (actionId) plan.actionId = actionId;
    plans.push(plan);
  }

  return plans
    .sort((a, b) => (b.surplusValue ?? 0) - (a.surplusValue ?? 0))
    .slice(0, 16);
}

function buildProblems(
  normalized: NormalizedSnapshot,
  incomeLines: OperationsIncomeLine[],
  bufferMaterials: BufferMaterial[],
  context: PlayerPlanningContext
): OperationsProblem[] {
  const problems: OperationsProblem[] = [];
  const targetHours = operationsBufferHours(context);
  const totalNet = incomeLines.reduce((sum, line) => sum + Math.max(0, line.netProfit), 0);
  const topNet = Math.max(0, ...incomeLines.map((line) => line.netProfit));

  for (const material of bufferMaterials.filter((item) => item.buyQty > 0)) {
    problems.push({
      id: `buffer-${material.matId}`,
      type: "production_bottleneck",
      severity: material.urgency,
      title: `${material.matName} below ${targetHours}h input buffer`,
      summary: `${material.coverageHours ?? 0}h covered; buy ${Math.ceil(material.buyQty).toLocaleString()} units to reach ${targetHours}h.`,
      evidence: [
        `${Math.ceil(material.ownedQty).toLocaleString()} owned vs ${Math.ceil(material.targetQty).toLocaleString()} target.`,
        material.estimatedCost !== undefined ? `Estimated fill cost ${formatMoney(material.estimatedCost)}.` : "Fill cost is unavailable."
      ],
      actionId: `buffer-${material.matId}`
    });
  }

  for (const line of incomeLines.filter((item) => item.netProfit <= 0)) {
    problems.push({
      id: `unprofitable-${line.recipeId}-${slug(line.baseName)}`,
      type: "unprofitable_product",
      severity: "high",
      title: `${line.outputMatName} is unprofitable over 12h`,
      summary: `${line.baseName} projects ${formatMoney(line.netProfit)} net from ${line.recipeName}.`,
      evidence: [`Gross ${formatMoney(line.grossOutputValue)} vs input cost ${formatMoney(line.inputCost)}.`, ...line.priceSources.slice(0, 2)],
      actionId: `review-production-${line.recipeId}`
    });
  }

  for (const line of incomeLines.filter((item) => item.netProfit > 0)) {
    const lowAbsoluteContribution = incomeLines.length > 1 && line.netProfit < Math.max(topNet * 0.2, totalNet * 0.08);
    if (!lowAbsoluteContribution) continue;
    problems.push({
      id: `low-impact-${line.recipeId}-${slug(line.baseName)}`,
      type: "less_profitable_product",
      severity: "medium",
      title: `${line.outputMatName} is a low-impact active product`,
      summary: `${line.outputMatName} contributes ${formatMoney(line.netProfit)} over 12h, materially below stronger active lines.`,
      evidence: [`Top active line: ${formatMoney(topNet)} net over 12h.`, `Total positive active net: ${formatMoney(totalNet)}.`],
      actionId: `review-production-${line.recipeId}`
    });
  }

  for (const warehouse of normalized.warehouses.filter((item) => item.utilization >= 0.9)) {
    problems.push({
      id: `warehouse-${warehouse.id ?? slug(warehouse.name)}`,
      type: "warehouse_capacity",
      severity: warehouse.utilization >= 0.98 ? "high" : "medium",
      title: `${warehouse.name} is near capacity`,
      summary: `${warehouse.name} is ${formatPct(warehouse.utilization * 100)} full with ${warehouse.freeTonnes ?? "unknown"} tonnes free.`,
      evidence: ["Check capacity before filling buffers or staging surplus moves."]
    });
  }

  return problems.sort((a, b) => problemSeverityScore(b.severity) - problemSeverityScore(a.severity)).slice(0, 16);
}

export function surplusActionThreshold(cash: number): number {
  return Math.max(500_000, Math.min(cash * 0.02, 2_500_000));
}

function buildPriceMap(snapshot: GameSnapshot, normalized: NormalizedSnapshot): Map<number, PriceInfo> {
  const prices = new Map<number, PriceInfo>();
  for (const item of [...snapshot.market.prices, ...snapshot.market.details]) {
    const matId = numberValue(item.matId) ?? numberValue(item.id);
    const price = numberValue(item.currentPrice);
    if (matId && price && price > 0) {
      const material = normalized.materials.get(matId);
      prices.set(matId, { value: price, source: "market", matName: text(item.matName) || material?.name || `Material ${matId}` });
    }
  }
  for (const material of normalized.materials.values()) {
    if (!prices.has(material.id) && material.cp && material.cp > 0) {
      prices.set(material.id, { value: material.cp, source: "cp", matName: material.name });
    }
  }
  return prices;
}

function activeRecipeOrders(snapshot: GameSnapshot): ActiveRecipeOrder[] {
  const recipes = new Map<number, Record<string, unknown>>();
  for (const recipe of recordArray(snapshot.gameData.recipes)) {
    const recipeId = numberValue(recipe.id);
    if (recipeId) recipes.set(recipeId, recipe);
  }

  const grouped = new Map<string, ActiveRecipeOrder>();
  for (const base of snapshot.bases) {
    const baseName = text(base.name) || `Base ${numberValue(base.id) ?? "?"}`;
    for (const order of recordArray(base.productionOrders)) {
      const nestedRecipe = recordValue(order.recipe);
      const recipeId = numberValue(order.recipeId) ?? numberValue(order.rId) ?? numberValue(nestedRecipe?.id);
      const recipe = recipeId ? recipes.get(recipeId) ?? nestedRecipe : undefined;
      if (!recipeId || !recipe) continue;
      const id = `${baseName}-${recipeId}`;
      const existing = grouped.get(id);
      if (existing) {
        existing.orderCount += 1;
      } else {
        grouped.set(id, { id, baseName, recipeId, orderCount: 1, recipe });
      }
    }
  }
  return [...grouped.values()];
}

function priceFor(matId: number, prices: Map<number, PriceInfo>, fallbackName?: string): PriceInfo {
  return prices.get(matId) ?? missingPrice(fallbackName ?? `Material ${matId}`);
}

function missingPrice(matName: string): PriceInfo {
  return { source: "missing", matName };
}

function bufferUrgency(coverageHours: number | undefined, targetHours: number): BufferMaterial["urgency"] {
  if (coverageHours === undefined) return "low";
  if (coverageHours <= 2) return "critical";
  if (coverageHours < Math.min(6, targetHours)) return "high";
  if (coverageHours < targetHours) return "medium";
  return "low";
}

function surplusRecommendation(input: {
  inventory: InventoryPosition;
  market: MarketSignal | undefined;
  profitableInputMatIds: Set<number>;
  meaningfulValue: boolean;
}): SurplusPlan["recommendation"] {
  if (input.profitableInputMatIds.has(input.inventory.matId)) return "feed_recipe";
  if (input.market?.recommendation === "sell" && input.meaningfulValue) {
    return input.inventory.exchangeQty > 0 ? "reprice" : "sell";
  }
  if (input.market?.recommendation === "sell") return "hold";
  if (input.inventory.baseQty > 0 && input.inventory.exchangeQty === 0 && input.meaningfulValue) return "move";
  return "hold";
}

function surplusReason(
  recommendation: SurplusPlan["recommendation"],
  surplusQty: number,
  surplusValue: number | undefined,
  threshold: number,
  market: MarketSignal | undefined,
  feedsProfitRecipe: boolean
): string {
  if (recommendation === "feed_recipe") return `${Math.ceil(surplusQty).toLocaleString()} surplus units can feed a company-fit or next-step recipe before selling.`;
  if (recommendation === "reprice") return `Surplus is already exchange-exposed and the premium is material enough to review repricing.`;
  if (recommendation === "sell") return `Surplus value is ${surplusValue !== undefined ? formatMoney(surplusValue) : "unknown"} and exceeds the ${formatMoney(threshold)} action threshold.`;
  if (recommendation === "move") return `Surplus appears outside the exchange; move only if live sell depth justifies the logistics.`;
  if (market?.recommendation === "sell" && surplusValue !== undefined && surplusValue < threshold) return `Premium exists, but ${formatMoney(surplusValue)} is below the ${formatMoney(threshold)} action threshold.`;
  if (feedsProfitRecipe) return "Hold until recipe-input use is confirmed.";
  return "Hold unless a fresh market check shows meaningful value or a better recipe use.";
}

function problemSeverityScore(severity: OperationsProblem["severity"]): number {
  if (severity === "critical") return 4;
  if (severity === "high") return 3;
  if (severity === "medium") return 2;
  return 1;
}

function uniqueStrings(items: Array<string | undefined>): string[] {
  return [...new Set(items.filter((item): item is string => Boolean(item && item.trim())))];
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "unknown";
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
