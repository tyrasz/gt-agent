import type {
  GameSnapshot,
  PlayerPlanningContext,
  ProfitabilityOpportunity,
  ProfitabilityRecipe,
  ProfitabilitySet
} from "../../shared/schemas.js";
import type { BuildingInfo, NormalizedSnapshot } from "./normalizers.js";
import { computeChainOpportunities } from "./chains.js";
import { materialId, materialQuantity } from "./normalizers.js";
import { clamp, formatMoney, formatPct, numberValue, recordArray, round, text } from "./utils.js";

type PriceInfo = {
  value: number;
  source: "market" | "cp";
  liquidityScore?: number;
};

type WorkerInfo = {
  type: number;
  name: string;
  consumables: Array<{ matId: number; amountPerDay: number; essential: boolean }>;
};

const PROFITABILITY_ASSUMPTIONS = [
  "Profitability uses current exchange prices when available and material CP as fallback.",
  "Figures are per production level/hour and exclude shipping, maintenance, perks, prestige, custom prices, and full expansion overhead.",
  "Worker consumables are included only when worker consumable data and prices can be parsed."
];

export function computeProfitability(
  snapshot: GameSnapshot,
  normalized: NormalizedSnapshot,
  context: PlayerPlanningContext
): ProfitabilitySet {
  const prices = buildPriceMap(snapshot, normalized);
  const workers = buildWorkerMap(snapshot);
  const recipes = recordArray(snapshot.gameData.recipes)
    .map((recipe) => computeRecipeProfitability(recipe, normalized, prices, workers))
    .filter((recipe): recipe is ProfitabilityRecipe => Boolean(recipe))
    .sort((a, b) => b.netEstimatePerHour - a.netEstimatePerHour)
    .slice(0, 80);

  const warnings = uniqueStrings([
    ...recipes.flatMap((recipe) => recipe.warnings).slice(0, 10),
    recipes.length === 0 ? "No profitable recipe economics could be computed from the current game data and market snapshot." : undefined
  ]);

  const profitable = recipes.filter((recipe) => recipe.netEstimatePerHour > 0 && recipe.outputValuePerHour > 0);
  const maxProfit = Math.max(1, ...profitable.map((recipe) => recipe.netEstimatePerHour));
  const companyFit = profitable
    .map((recipe) => opportunityForRecipe(recipe, "company", maxProfit, context, normalized))
    .filter((opportunity): opportunity is ProfitabilityOpportunity => Boolean(opportunity))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
  const companyRecipeIds = new Set(companyFit.map((opportunity) => opportunity.recipeId));
  const globalTargets = profitable
    .map((recipe) => opportunityForRecipe(recipe, "global", maxProfit, context, normalized))
    .filter((opportunity): opportunity is ProfitabilityOpportunity => Boolean(opportunity))
    .sort((a, b) => b.score - a.score)
    .filter((opportunity, index) => index < 12 || !companyRecipeIds.has(opportunity.recipeId))
    .slice(0, 8);
  const chains = computeChainOpportunities(recipes, context);

  return {
    recipes,
    companyFit,
    globalTargets,
    chains: chains.chains,
    chainOpportunities: chains.chainOpportunities,
    assumptions: PROFITABILITY_ASSUMPTIONS,
    warnings
  };
}

export function profitabilityMarginByMaterial(profitability: ProfitabilitySet): Map<number, number> {
  const margins = new Map<number, number>();
  for (const recipe of profitability.recipes) {
    if (recipe.marginPct === undefined) continue;
    margins.set(recipe.outputMatId, Math.max(margins.get(recipe.outputMatId) ?? -Infinity, recipe.marginPct));
    for (const inputMatId of recipe.inputMatIds) {
      margins.set(inputMatId, Math.max(margins.get(inputMatId) ?? -Infinity, recipe.marginPct));
    }
  }
  return margins;
}

function computeRecipeProfitability(
  recipe: Record<string, unknown>,
  normalized: NormalizedSnapshot,
  prices: Map<number, PriceInfo>,
  workers: Map<number, WorkerInfo>
): ProfitabilityRecipe | undefined {
  const recipeId = numberValue(recipe.id) ?? 0;
  const output = recordValue(recipe.output);
  const outputMatId = output ? materialId(output) : undefined;
  const outputAmount = output ? materialQuantity(output) || 1 : 1;
  if (!recipeId || !outputMatId) return undefined;

  const outputMat = normalized.materials.get(outputMatId);
  const outputPrice = priceForMaterial(outputMatId, prices);
  if (!outputPrice) return undefined;

  const buildingId = numberValue(recipe.producedIn) ?? numberValue(recipe.buildingId);
  const building = buildingId ? normalized.buildings.get(buildingId) : undefined;
  const timeMinutes = Math.max(1, numberValue(recipe.timeMinutes) ?? numberValue(recipe.minutes) ?? 60);
  const cyclesPerHour = 60 / timeMinutes;
  const warnings: string[] = [];
  const inputs = recordArray(recipe.inputs);
  let inputCostPerRun = 0;
  let inputCoverageTotal = 0;
  let missingInputPrices = 0;
  let fallbackInputPrices = 0;
  const inputMatIds: number[] = [];

  for (const input of inputs) {
    const inputMatId = materialId(input);
    const amount = materialQuantity(input);
    if (!inputMatId || amount <= 0) continue;
    inputMatIds.push(inputMatId);
    const price = priceForMaterial(inputMatId, prices);
    if (!price) {
      missingInputPrices += 1;
      continue;
    }
    if (price.source === "cp") fallbackInputPrices += 1;
    inputCostPerRun += price.value * amount;
    const ownedQty = normalized.inventory.get(inputMatId)?.totalQty ?? 0;
    inputCoverageTotal += clamp((ownedQty / amount) * 100);
  }

  const outputValuePerRun = outputPrice.value * outputAmount;
  const inputCostPerHour = round(inputCostPerRun * cyclesPerHour);
  const outputValuePerHour = round(outputValuePerRun * cyclesPerHour);
  const grossProfitPerHour = round(outputValuePerHour - inputCostPerHour);
  const workerConsumableCostPerHour = computeWorkerConsumableCostPerHour(building, workers, prices);
  const netEstimatePerHour = round(grossProfitPerHour - (workerConsumableCostPerHour.cost ?? 0));
  const marginPct = inputCostPerHour > 0 ? round((grossProfitPerHour / inputCostPerHour) * 100) : undefined;
  const workerBurden = building?.workersNeeded.reduce((sum, count) => sum + count, 0) ?? 0;
  const profitPer100Burden = workerBurden > 0 ? round((netEstimatePerHour / workerBurden) * 100) : undefined;
  const liquidityScore = liquidityForMaterial(outputMatId, prices);
  const inputCoveragePct = inputs.length > 0 ? round(inputCoverageTotal / inputs.length) : 100;
  const setupGaps = setupGapsForRecipe(recipeId, building, normalized, inputCoveragePct, liquidityScore);
  const setupCostEstimate = setupCostForBuilding(building, prices);
  if (outputPrice.source === "cp") warnings.push(`${outputMat?.name ?? `Material ${outputMatId}`} uses CP fallback for output price.`);
  if (fallbackInputPrices > 0) warnings.push(`${fallbackInputPrices} input price(s) use CP fallback.`);
  if (missingInputPrices > 0) warnings.push(`${missingInputPrices} input price(s) could not be priced.`);
  if (workerConsumableCostPerHour.warning) warnings.push(workerConsumableCostPerHour.warning);
  if (inputs.length === 0) warnings.push("Recipe has no priced inputs, so margin percent is omitted.");

  const outputName = outputMat?.name ?? text(output?.matName) ?? text(output?.name) ?? `Material ${outputMatId}`;

  return {
    recipeId,
    recipeName: text(recipe.name) || `${outputName} recipe`,
    outputMatId,
    outputMatName: outputName,
    inputMatIds: [...new Set(inputMatIds)],
    buildingId,
    buildingName: building?.name,
    industry: building?.industry,
    inputCostPerHour,
    outputValuePerHour,
    grossProfitPerHour,
    workerConsumableCostPerHour: workerConsumableCostPerHour.cost,
    netEstimatePerHour,
    marginPct,
    profitPer100Burden,
    outputUnitsPerHour: round(outputAmount * cyclesPerHour),
    inputCoveragePct,
    liquidityScore,
    priceConfidence: priceConfidence(outputPrice, fallbackInputPrices, missingInputPrices, liquidityScore),
    companyFit: companyFitForRecipe(recipeId, buildingId, setupGaps, normalized),
    setupCostEstimate,
    setupGaps,
    warnings: uniqueStrings(warnings)
  };
}

function opportunityForRecipe(
  recipe: ProfitabilityRecipe,
  scope: "company" | "global",
  maxProfit: number,
  context: PlayerPlanningContext,
  normalized: NormalizedSnapshot
): ProfitabilityOpportunity | undefined {
  if (recipe.netEstimatePerHour <= 0) return undefined;
  const profitScore = clamp((recipe.netEstimatePerHour / maxProfit) * 100);
  const confidenceScore = recipe.priceConfidence === "high" ? 95 : recipe.priceConfidence === "medium" ? 65 : 35;
  const cashScore = setupCashScore(recipe.setupCostEstimate, normalized.cash, context.cashRiskLevel);
  const fitScore = recipe.companyFit === "active" ? 100 : recipe.companyFit === "owned" ? 90 : recipe.companyFit === "available" ? 58 : 35;
  const inputScore = recipe.inputCoveragePct;
  const prompt = `${context.userPrompt ?? ""} ${context.shortTermGoal} ${context.notes ?? ""}`.toLowerCase();
  const goalBoost = /cv|profit|margin|value|grow|expand/.test(prompt) ? 8 : 0;
  const baseScore = round(profitScore * 0.34 + fitScore * 0.24 + inputScore * 0.16 + confidenceScore * 0.14 + cashScore * 0.12 + goalBoost);

  if (scope === "global") {
    const globalScore = round(profitScore * 0.55 + confidenceScore * 0.2 + recipe.liquidityScore * 0.15 + cashScore * 0.1);
    return {
      id: `profit-global-${recipe.recipeId}`,
      kind: "restructure_toward",
      recipeId: recipe.recipeId,
      title: `Restructure toward ${recipe.outputMatName}`,
      recommendation: `Treat ${recipe.outputMatName} as a long-horizon target if live margins persist.`,
      horizonId: "d7",
      horizonLabel: "7 Days",
      score: round(globalScore),
      confidence: confidenceForScore(confidenceScore),
      profitPerHour: recipe.netEstimatePerHour,
      marginPct: recipe.marginPct,
      rationale: [
        `${formatMoney(recipe.netEstimatePerHour)}/h estimated net production value.`,
        recipe.buildingName ? `Requires ${recipe.buildingName}.` : "Required building was not identified in game data.",
        `${Math.round(recipe.liquidityScore)} output liquidity score.`
      ],
      blockers: recipe.setupGaps
    };
  }

  if (recipe.companyFit === "target") return undefined;
  const kind = recipe.companyFit === "active" || recipe.companyFit === "owned"
    ? recipe.inputCoveragePct >= 90 ? "run_now" : "stage_inputs"
    : recipe.setupCostEstimate !== undefined && recipe.setupCostEstimate <= normalized.cash ? "expand_for_recipe" : "restructure_toward";
  const horizon = kind === "run_now"
    ? { id: "h12", label: "Next 12h" }
    : kind === "stage_inputs"
      ? { id: "d1", label: "1 Day" }
      : kind === "expand_for_recipe"
        ? { id: "d3", label: "3 Days" }
        : { id: "d7", label: "7 Days" };
  return {
    id: `profit-company-${recipe.recipeId}`,
    kind,
    recipeId: recipe.recipeId,
    title: opportunityTitle(kind, recipe),
    recommendation: opportunityRecommendation(kind, recipe),
    horizonId: horizon.id,
    horizonLabel: horizon.label,
    score: round(baseScore),
    confidence: confidenceForScore((confidenceScore + fitScore + inputScore) / 3),
    profitPerHour: recipe.netEstimatePerHour,
    marginPct: recipe.marginPct,
    rationale: [
      `${formatMoney(recipe.netEstimatePerHour)}/h estimated net value${recipe.marginPct !== undefined ? ` at ${formatPct(recipe.marginPct)} margin` : ""}.`,
      `${Math.round(recipe.inputCoveragePct)}% one-run input coverage from visible inventory.`,
      `${Math.round(recipe.liquidityScore)} output liquidity score.`
    ],
    blockers: recipe.setupGaps
  };
}

function buildPriceMap(snapshot: GameSnapshot, normalized: NormalizedSnapshot): Map<number, PriceInfo> {
  const prices = new Map<number, PriceInfo>();
  for (const item of [...snapshot.market.prices, ...snapshot.market.details]) {
    const matId = numberValue(item.matId) ?? numberValue(item.id);
    const price = numberValue(item.currentPrice);
    if (matId && price && price > 0) {
      const avgQtySoldDaily = numberValue(item.avgQtySoldDaily);
      const totalQtyAvailable = numberValue(item.totalQtyAvailable);
      const daysMarketSupply = totalQtyAvailable !== undefined && avgQtySoldDaily && avgQtySoldDaily > 0 ? totalQtyAvailable / avgQtySoldDaily : undefined;
      prices.set(matId, {
        value: price,
        source: "market",
        liquidityScore: computeLiquidityScore(avgQtySoldDaily, totalQtyAvailable, daysMarketSupply)
      });
    }
  }
  for (const material of normalized.materials.values()) {
    if (!prices.has(material.id) && material.cp && material.cp > 0) {
      prices.set(material.id, { value: material.cp, source: "cp", liquidityScore: 20 });
    }
  }
  return prices;
}

function buildWorkerMap(snapshot: GameSnapshot): Map<number, WorkerInfo> {
  const workers = new Map<number, WorkerInfo>();
  for (const item of recordArray(snapshot.gameData.workers)) {
    const type = numberValue(item.type) ?? numberValue(item.id);
    if (!type) continue;
    workers.set(type, {
      type,
      name: text(item.name) || `Worker ${type}`,
      consumables: recordArray(item.consumables).map((mat) => ({
        matId: materialId(mat) ?? 0,
        amountPerDay: materialQuantity(mat),
        essential: typeof mat.essential === "boolean" ? mat.essential : true
      })).filter((mat) => mat.matId > 0 && mat.amountPerDay > 0)
    });
  }
  return workers;
}

function computeWorkerConsumableCostPerHour(
  building: BuildingInfo | undefined,
  workers: Map<number, WorkerInfo>,
  prices: Map<number, PriceInfo>
): { cost?: number; warning?: string } {
  if (!building || building.workersNeeded.length === 0 || workers.size === 0) return {};
  let cost = 0;
  let priced = 0;
  let missing = 0;
  building.workersNeeded.forEach((count, index) => {
    if (count <= 0) return;
    const worker = workers.get(index + 1);
    if (!worker) return;
    for (const consumable of worker.consumables.filter((item) => item.essential)) {
      const price = prices.get(consumable.matId);
      if (!price) {
        missing += 1;
        continue;
      }
      cost += (consumable.amountPerDay / (1000 * 24)) * count * price.value;
      priced += 1;
    }
  });
  return {
    cost: priced > 0 ? round(cost) : undefined,
    warning: missing > 0 ? `${missing} worker consumable price(s) missing from profitability estimate.` : undefined
  };
}

function priceForMaterial(matId: number, prices: Map<number, PriceInfo>): PriceInfo | undefined {
  return prices.get(matId);
}

function liquidityForMaterial(matId: number, prices: Map<number, PriceInfo>): number {
  return prices.get(matId)?.liquidityScore ?? 20;
}

function computeLiquidityScore(avgQtySoldDaily?: number, totalQtyAvailable?: number, daysMarketSupply?: number): number {
  const velocity = avgQtySoldDaily !== undefined ? clamp((avgQtySoldDaily / 1000) * 45) : 10;
  const depth = totalQtyAvailable !== undefined ? clamp((totalQtyAvailable / 10_000) * 35) : 10;
  const supply = daysMarketSupply !== undefined ? clamp(20 - Math.abs(daysMarketSupply - 3) * 4, 0, 20) : 5;
  return round(velocity + depth + supply);
}

function setupGapsForRecipe(
  recipeId: number,
  building: BuildingInfo | undefined,
  normalized: NormalizedSnapshot,
  inputCoveragePct: number,
  liquidityScore: number
): string[] {
  const gaps: string[] = [];
  if (!building) gaps.push("Production building is unknown in game data.");
  if (building && !normalized.ownedBuildingIds.has(building.id) && !normalized.activeRecipeIds.has(recipeId)) {
    gaps.push(`Build or acquire ${building.name}.`);
  }
  if (building?.requiredResearch && building.requiredResearch > 0 && !normalized.ownedBuildingIds.has(building.id)) {
    gaps.push(`Confirm research requirement ${building.requiredResearch}.`);
  }
  if (inputCoveragePct < 90) gaps.push(`Stage inputs; visible inventory covers ${Math.round(inputCoveragePct)}% of one run.`);
  if (liquidityScore < 35) gaps.push("Confirm output market depth before scaling.");
  return gaps;
}

function setupCostForBuilding(building: BuildingInfo | undefined, prices: Map<number, PriceInfo>): number | undefined {
  if (!building) return undefined;
  let cost = building.cost ?? 0;
  let hasAny = Boolean(building.cost);
  for (const mat of building.constructionMaterials) {
    const price = prices.get(mat.matId);
    if (!price) continue;
    cost += price.value * mat.quantity;
    hasAny = true;
  }
  return hasAny ? round(cost) : undefined;
}

function priceConfidence(outputPrice: PriceInfo, fallbackInputs: number, missingInputs: number, liquidityScore: number): ProfitabilityRecipe["priceConfidence"] {
  if (missingInputs > 0 || liquidityScore < 25) return "low";
  if (outputPrice.source === "cp" || fallbackInputs > 0 || liquidityScore < 45) return "medium";
  return "high";
}

function companyFitForRecipe(
  recipeId: number,
  buildingId: number | undefined,
  setupGaps: string[],
  normalized: NormalizedSnapshot
): ProfitabilityRecipe["companyFit"] {
  if (normalized.activeRecipeIds.has(recipeId)) return "active";
  if (buildingId && normalized.ownedBuildingIds.has(buildingId)) return "owned";
  if (setupGaps.length <= 2) return "available";
  return "target";
}

function setupCashScore(setupCost: number | undefined, cash: number, risk: PlayerPlanningContext["cashRiskLevel"]): number {
  if (!setupCost || setupCost <= 0) return 82;
  if (cash <= 0) return 20;
  const limit = risk === "conservative" ? 0.12 : risk === "aggressive" ? 0.55 : 0.28;
  const ratio = setupCost / cash;
  return clamp(100 - (ratio / limit) * 60);
}

function opportunityTitle(kind: ProfitabilityOpportunity["kind"], recipe: ProfitabilityRecipe): string {
  if (kind === "run_now") return `Run profitable ${recipe.outputMatName}`;
  if (kind === "stage_inputs") return `Stage inputs for ${recipe.outputMatName}`;
  if (kind === "expand_for_recipe") return `Prepare ${recipe.buildingName ?? "production"} for ${recipe.outputMatName}`;
  if (kind === "reprice_output") return `Reprice ${recipe.outputMatName}`;
  return `Restructure toward ${recipe.outputMatName}`;
}

function opportunityRecommendation(kind: ProfitabilityOpportunity["kind"], recipe: ProfitabilityRecipe): string {
  if (kind === "run_now") return `Use existing production fit if live inputs and output prices still support ${formatMoney(recipe.netEstimatePerHour)}/h.`;
  if (kind === "stage_inputs") return "Stage missing inputs before committing the production loop.";
  if (kind === "expand_for_recipe") return `Prepare the facility path for ${recipe.outputMatName}, then commit only if margin persists.`;
  if (kind === "reprice_output") return "Review owned output sell price against live exchange depth.";
  return `Treat ${recipe.outputMatName} as a restructure target, not an immediate spend.`;
}

function confidenceForScore(score: number): ProfitabilityOpportunity["confidence"] {
  if (score >= 75) return "high";
  if (score >= 45) return "medium";
  return "low";
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function uniqueStrings(items: Array<string | undefined>): string[] {
  return [...new Set(items.filter((item): item is string => Boolean(item && item.trim())))];
}
