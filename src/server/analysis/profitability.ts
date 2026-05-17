import type {
  CapitalFit,
  GameSnapshot,
  PlayerPlanningContext,
  ProfitabilityOpportunity,
  ProfitabilityRecipe,
  ProfitabilitySet,
  SetupCostCompleteness,
  SetupDistance
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

type Feasibility = {
  capitalFit: CapitalFit;
  setupDistance: SetupDistance;
  resourceAccess: ResourceAccess;
  planetRequirement?: string;
  techRequirement?: string;
  setupCostCompleteness: SetupCostCompleteness;
  setupCostEstimate?: number;
  knownMinimumCapital?: number;
  knownCapitalGap?: number;
  cashAfterSetup?: number;
  cashImpactPct?: number;
  firstPracticalStep: string;
  missingPrerequisites: string[];
  unpricedRequirements: string[];
  blockingReasons: string[];
};

type ResourceAccess = NonNullable<ProfitabilityRecipe["resourceAccess"]>;

type SetupCost = {
  cost?: number;
  completeness: SetupCostCompleteness;
  unpricedRequirements: string[];
};

const PROFITABILITY_ASSUMPTIONS = [
  "Profitability uses current exchange prices when available and material CP as fallback.",
  "Figures are per production level/hour and exclude shipping, maintenance, perks, prestige, custom prices, and full expansion overhead.",
  "Blocked references show known minimum capital from priced setup components plus reserve; unpriced planet/resource/research requirements are listed separately.",
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
    .map((recipe) => computeRecipeProfitability(recipe, normalized, prices, workers, context))
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
    .filter((recipe) => recipe.companyFit === "active" || recipe.companyFit === "owned")
    .map((recipe) => opportunityForRecipe(recipe, "company", maxProfit, context))
    .filter((opportunity): opportunity is ProfitabilityOpportunity => Boolean(opportunity))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
  const companyRecipeIds = new Set(companyFit.map((opportunity) => opportunity.recipeId));
  const nextSteps = profitable
    .filter((recipe) => !companyRecipeIds.has(recipe.recipeId))
    .filter((recipe) => recipe.capitalFit === "affordable" && recipe.setupDistance !== "unreachable_now" && (recipe.blockingReasons ?? []).length === 0)
    .map((recipe) => opportunityForRecipe(recipe, "next_step", maxProfit, context))
    .filter((opportunity): opportunity is ProfitabilityOpportunity => Boolean(opportunity))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
  const practicalRecipeIds = new Set([...companyRecipeIds, ...nextSteps.map((opportunity) => opportunity.recipeId)]);
  const blockedTargets = profitable
    .filter((recipe) => !practicalRecipeIds.has(recipe.recipeId))
    .filter((recipe) => (recipe.blockingReasons ?? []).length > 0 || recipe.capitalFit === "blocked" || recipe.capitalFit === "unknown")
    .map((recipe) => opportunityForRecipe(recipe, "blocked", maxProfit, context))
    .filter((opportunity): opportunity is ProfitabilityOpportunity => Boolean(opportunity))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
  const blockedRecipeIds = new Set(blockedTargets.map((opportunity) => opportunity.recipeId));
  const aspirationalTargets = profitable
    .filter((recipe) => !practicalRecipeIds.has(recipe.recipeId))
    .filter((recipe) => !blockedRecipeIds.has(recipe.recipeId))
    .map((recipe) => opportunityForRecipe(recipe, "aspirational", maxProfit, context))
    .filter((opportunity): opportunity is ProfitabilityOpportunity => Boolean(opportunity))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
  const chains = computeChainOpportunities(recipes, context);

  return {
    recipes,
    companyFit,
    nextSteps,
    aspirationalTargets,
    blockedTargets,
    globalTargets: [...aspirationalTargets, ...blockedTargets],
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
  workers: Map<number, WorkerInfo>,
  context: PlayerPlanningContext
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
  const outputName = outputMat?.name ?? text(output?.matName) ?? text(output?.name) ?? `Material ${outputMatId}`;
  const setupGaps = setupGapsForRecipe(recipeId, outputName, building, normalized, inputCoveragePct, liquidityScore);
  const setupCost = setupCostForBuilding(building, prices);
  const companyFit = companyFitForRecipe(recipeId, buildingId, setupGaps, normalized);
  const feasibility = feasibilityForRecipe({
    recipeId,
    outputName,
    building,
    companyFit,
    inputCoveragePct,
    liquidityScore,
    setupGaps,
    setupCost,
    resourceRecipe: isResourceExtractionRecipe(building, outputName, inputs.length),
    cash: normalized.cash,
    risk: context.cashRiskLevel
  });
  if (outputPrice.source === "cp") warnings.push(`${outputMat?.name ?? `Material ${outputMatId}`} uses CP fallback for output price.`);
  if (fallbackInputPrices > 0) warnings.push(`${fallbackInputPrices} input price(s) use CP fallback.`);
  if (missingInputPrices > 0) warnings.push(`${missingInputPrices} input price(s) could not be priced.`);
  if (workerConsumableCostPerHour.warning) warnings.push(workerConsumableCostPerHour.warning);
  if (inputs.length === 0) warnings.push("Recipe has no priced inputs, so margin percent is omitted.");

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
    companyFit,
    capitalFit: feasibility.capitalFit,
    setupDistance: feasibility.setupDistance,
    resourceAccess: feasibility.resourceAccess,
    planetRequirement: feasibility.planetRequirement,
    techRequirement: feasibility.techRequirement,
    setupCostCompleteness: feasibility.setupCostCompleteness,
    setupCostEstimate: feasibility.setupCostEstimate,
    knownMinimumCapital: feasibility.knownMinimumCapital,
    knownCapitalGap: feasibility.knownCapitalGap,
    cashAfterSetup: feasibility.cashAfterSetup,
    cashImpactPct: feasibility.cashImpactPct,
    firstPracticalStep: feasibility.firstPracticalStep,
    missingPrerequisites: feasibility.missingPrerequisites,
    unpricedRequirements: feasibility.unpricedRequirements,
    blockingReasons: feasibility.blockingReasons,
    setupGaps,
    warnings: uniqueStrings(warnings)
  };
}

function opportunityForRecipe(
  recipe: ProfitabilityRecipe,
  scope: "company" | "next_step" | "aspirational" | "blocked",
  maxProfit: number,
  context: PlayerPlanningContext
): ProfitabilityOpportunity | undefined {
  if (recipe.netEstimatePerHour <= 0) return undefined;
  const profitScore = clamp((recipe.netEstimatePerHour / maxProfit) * 100);
  const confidenceScore = recipe.priceConfidence === "high" ? 95 : recipe.priceConfidence === "medium" ? 65 : 35;
  const cashScore = capitalScore(recipe.capitalFit, recipe.cashImpactPct);
  const fitScore = recipe.companyFit === "active" ? 100 : recipe.companyFit === "owned" ? 90 : recipe.companyFit === "available" ? 58 : 35;
  const inputScore = recipe.inputCoveragePct;
  const prompt = `${context.userPrompt ?? ""} ${context.shortTermGoal} ${context.notes ?? ""}`.toLowerCase();
  const goalBoost = /cv|profit|margin|value|grow|expand/.test(prompt) ? 8 : 0;
  const baseScore = round(profitScore * 0.28 + fitScore * 0.22 + cashScore * 0.22 + inputScore * 0.12 + confidenceScore * 0.1 + goalBoost);
  const missingPrerequisites = recipe.missingPrerequisites ?? [];

  if (scope === "aspirational" || scope === "blocked") {
    const aspirationalScore = round(profitScore * 0.48 + confidenceScore * 0.17 + recipe.liquidityScore * 0.12 + cashScore * 0.1 + fitScore * 0.08 + inputScore * 0.05);
    const blocked = scope === "blocked";
    return {
      id: `profit-global-${recipe.recipeId}`,
      kind: "restructure_toward",
      recipeId: recipe.recipeId,
      title: `Restructure toward ${recipe.outputMatName}`,
      recommendation: blocked
        ? `Keep ${recipe.outputMatName} as a blocked long-term reference until planet/resource, tech, and capital blockers are cleared.`
        : `Treat ${recipe.outputMatName} as aspirational until the listed capital and setup blockers are cleared.`,
      horizonId: "d7",
      horizonLabel: "7 Days",
      score: blocked ? Math.min(35, round(aspirationalScore)) : round(aspirationalScore),
      confidence: blocked ? "low" : confidenceForScore(confidenceScore),
      profitPerHour: recipe.netEstimatePerHour,
      marginPct: recipe.marginPct,
      capitalFit: recipe.capitalFit,
      setupDistance: recipe.setupDistance,
      resourceAccess: recipe.resourceAccess,
      planetRequirement: recipe.planetRequirement,
      techRequirement: recipe.techRequirement,
      setupCostCompleteness: recipe.setupCostCompleteness,
      setupCostEstimate: recipe.setupCostEstimate,
      knownMinimumCapital: recipe.knownMinimumCapital,
      knownCapitalGap: recipe.knownCapitalGap,
      cashAfterSetup: recipe.cashAfterSetup,
      cashImpactPct: recipe.cashImpactPct,
      firstPracticalStep: recipe.firstPracticalStep,
      missingPrerequisites,
      unpricedRequirements: recipe.unpricedRequirements,
      blockingReasons: recipe.blockingReasons,
      rationale: [
        `${formatMoney(recipe.netEstimatePerHour)}/h estimated net production value.`,
        recipe.buildingName ? `Requires ${recipe.buildingName}.` : "Required building was not identified in game data.",
        `${Math.round(recipe.liquidityScore)} output liquidity score.`,
        recipe.knownMinimumCapital !== undefined ? `Known minimum capital is ${formatMoney(recipe.knownMinimumCapital)} before unpriced gaps.` : undefined,
        recipe.firstPracticalStep ?? "Confirm prerequisites before treating this as a path."
      ].filter((item): item is string => Boolean(item)),
      blockers: missingPrerequisites.length > 0 ? missingPrerequisites : recipe.setupGaps
    };
  }

  if (scope === "company" && recipe.companyFit === "target") return undefined;
  const kind: ProfitabilityOpportunity["kind"] = scope === "next_step"
    ? "expand_for_recipe"
    : recipe.companyFit === "active" || recipe.companyFit === "owned"
    ? recipe.inputCoveragePct >= 90 ? "run_now" : "stage_inputs"
    : "expand_for_recipe";
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
    capitalFit: recipe.capitalFit,
    setupDistance: recipe.setupDistance,
    resourceAccess: recipe.resourceAccess,
    planetRequirement: recipe.planetRequirement,
    techRequirement: recipe.techRequirement,
    setupCostCompleteness: recipe.setupCostCompleteness,
    setupCostEstimate: recipe.setupCostEstimate,
    knownMinimumCapital: recipe.knownMinimumCapital,
    knownCapitalGap: recipe.knownCapitalGap,
    cashAfterSetup: recipe.cashAfterSetup,
    cashImpactPct: recipe.cashImpactPct,
    firstPracticalStep: recipe.firstPracticalStep,
    missingPrerequisites,
    unpricedRequirements: recipe.unpricedRequirements,
    blockingReasons: recipe.blockingReasons,
    rationale: [
      `${formatMoney(recipe.netEstimatePerHour)}/h estimated net value${recipe.marginPct !== undefined ? ` at ${formatPct(recipe.marginPct)} margin` : ""}.`,
      `${Math.round(recipe.inputCoveragePct)}% one-run input coverage from visible inventory.`,
      `${Math.round(recipe.liquidityScore)} output liquidity score.`,
      recipe.firstPracticalStep ?? ""
    ],
    blockers: missingPrerequisites.length > 0 ? missingPrerequisites : recipe.setupGaps
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
  outputName: string,
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
  if (building && isResourceExtractionRecipe(building, outputName, undefined) && !normalized.ownedBuildingIds.has(building.id) && !normalized.activeRecipeIds.has(recipeId)) {
    gaps.push(`Confirm planet/resource access for ${outputName}.`);
  }
  if (inputCoveragePct < 90) gaps.push(`Stage inputs; visible inventory covers ${Math.round(inputCoveragePct)}% of one run.`);
  if (liquidityScore < 35) gaps.push("Confirm output market depth before scaling.");
  return gaps;
}

function setupCostForBuilding(building: BuildingInfo | undefined, prices: Map<number, PriceInfo>): SetupCost {
  if (!building) {
    return {
      completeness: "unknown",
      unpricedRequirements: ["Required production building is unknown in game data."]
    };
  }
  let cost = building.cost ?? 0;
  let hasAny = Boolean(building.cost);
  const unpricedRequirements: string[] = [];
  for (const mat of building.constructionMaterials) {
    const price = prices.get(mat.matId);
    if (!price) {
      unpricedRequirements.push(`Construction material ${mat.matId} cost is not priced in the current snapshot.`);
      continue;
    }
    cost += price.value * mat.quantity;
    hasAny = true;
  }
  if (!hasAny) {
    return {
      completeness: "unknown",
      unpricedRequirements: ["Building setup cost is not priced in game data."]
    };
  }
  return {
    cost: round(cost),
    completeness: unpricedRequirements.length > 0 ? "partial" : "complete",
    unpricedRequirements
  };
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

function feasibilityForRecipe(input: {
  recipeId: number;
  outputName: string;
  building: BuildingInfo | undefined;
  companyFit: ProfitabilityRecipe["companyFit"];
  inputCoveragePct: number;
  liquidityScore: number;
  setupGaps: string[];
  setupCost: SetupCost;
  resourceRecipe: boolean;
  cash: number;
  risk: PlayerPlanningContext["cashRiskLevel"];
}): Feasibility {
  const requiresFacilitySetup = input.companyFit !== "active" && input.companyFit !== "owned";
  const setupCost = requiresFacilitySetup ? input.setupCost.cost : 0;
  const missingPrerequisites = [...input.setupGaps];
  const blockingReasons: string[] = [];
  const unpricedRequirements = requiresFacilitySetup ? [...input.setupCost.unpricedRequirements] : [];
  const spendCap = spendCapForRisk(input.cash, input.risk);
  const reserve = practicalReserve(input.cash, input.risk);
  const knownMinimumCapital = requiresFacilitySetup && setupCost !== undefined ? round(setupCost + reserve) : setupCost;
  const knownCapitalGap = knownMinimumCapital !== undefined ? Math.max(0, round(knownMinimumCapital - input.cash)) : undefined;
  const cashAfterSetup = setupCost !== undefined ? round(input.cash - setupCost) : undefined;
  const cashImpactPct = setupCost !== undefined && input.cash > 0 ? round((setupCost / input.cash) * 100) : undefined;
  const resourceAccess = resourceAccessForRecipe(input.resourceRecipe, input.companyFit);
  const planetRequirement = input.resourceRecipe && resourceAccess !== "owned" ? `Requires a planet/base with ${input.outputName} resource access.` : undefined;
  const techRequirement = input.building?.requiredResearch && input.building.requiredResearch > 0 && requiresFacilitySetup
    ? `Requires research level ${input.building.requiredResearch} before ${input.building.name} can be treated as available.`
    : undefined;
  let setupCostCompleteness = requiresFacilitySetup ? input.setupCost.completeness : "complete";
  let capitalFit: CapitalFit;

  if (resourceAccess === "blocked") {
    blockingReasons.push(planetRequirement ?? `Planet/resource access for ${input.outputName} is not visible in the current company snapshot.`);
    unpricedRequirements.push(`New planet/base/resource access for ${input.outputName} is not priced from the current snapshot.`);
  }

  if (techRequirement) {
    blockingReasons.push(techRequirement);
    unpricedRequirements.push(`Research path cost for requirement ${input.building?.requiredResearch} is not priced from the current snapshot.`);
  }

  if (requiresFacilitySetup && setupCostCompleteness !== "complete") {
    blockingReasons.push("Setup cost is incomplete, so this cannot be treated as capital-feasible.");
  }

  if (blockingReasons.length > 0) {
    capitalFit = setupCost === undefined ? "unknown" : "blocked";
    if (setupCost === undefined) setupCostCompleteness = "unknown";
  } else if (!requiresFacilitySetup || setupCost === 0) {
    capitalFit = "affordable";
  } else if (setupCost === undefined) {
    capitalFit = "unknown";
    missingPrerequisites.push("Confirm setup cost before this can become a recommendation.");
  } else if (setupCost <= spendCap && cashAfterSetup !== undefined && cashAfterSetup >= reserve) {
    capitalFit = "affordable";
  } else if (setupCost <= input.cash && cashAfterSetup !== undefined && cashAfterSetup >= reserve * 0.5) {
    capitalFit = "stretch";
    missingPrerequisites.push(`${formatMoney(setupCost)} setup cost exceeds the ${riskLabel(input.risk)} spend cap of ${formatMoney(spendCap)}.`);
  } else {
    capitalFit = "blocked";
    missingPrerequisites.push(`Needs about ${formatMoney(setupCost)} setup cash; current ${riskLabel(input.risk)} cap is ${formatMoney(spendCap)}.`);
  }

  const setupDistance: SetupDistance =
    capitalFit === "blocked" || capitalFit === "unknown"
      ? "unreachable_now"
      : input.companyFit === "active" || input.companyFit === "owned"
        ? input.inputCoveragePct >= 90 && input.liquidityScore >= 35 ? "ready" : "one_step"
        : input.setupGaps.length <= 2 ? "one_step" : "multi_step";

  return {
    capitalFit,
    setupDistance,
    resourceAccess,
    planetRequirement,
    techRequirement,
    setupCostCompleteness,
    setupCostEstimate: setupCost,
    knownMinimumCapital,
    knownCapitalGap,
    cashAfterSetup,
    cashImpactPct,
    firstPracticalStep: firstPracticalStep(input, capitalFit, setupDistance, setupCost, spendCap, blockingReasons, knownMinimumCapital),
    missingPrerequisites: uniqueStrings([...missingPrerequisites, ...blockingReasons]),
    unpricedRequirements: uniqueStrings(unpricedRequirements),
    blockingReasons: uniqueStrings(blockingReasons)
  };
}

function firstPracticalStep(
  input: {
    outputName: string;
    building: BuildingInfo | undefined;
    companyFit: ProfitabilityRecipe["companyFit"];
    inputCoveragePct: number;
  },
  capitalFit: CapitalFit,
  setupDistance: SetupDistance,
  setupCost: number | undefined,
  spendCap: number,
  blockingReasons: string[],
  knownMinimumCapital: number | undefined
): string {
  if (input.companyFit === "active" || input.companyFit === "owned") {
    if (input.inputCoveragePct < 90) return `Stage inputs for ${input.outputName} before scaling production.`;
    return `Run or reprice ${input.outputName} using existing production fit.`;
  }
  if (blockingReasons.length > 0) {
    const minimum = knownMinimumCapital !== undefined ? ` Known minimum capital before unpriced gaps is ${formatMoney(knownMinimumCapital)}.` : "";
    return `Do not plan ${input.outputName} as a next move until blocked prerequisites are resolved.${minimum}`;
  }
  if (capitalFit === "affordable") {
    return `Prepare ${input.building?.name ?? "the required building"} for ${input.outputName}; setup is within the current spend cap.`;
  }
  if (capitalFit === "stretch") {
    return `Treat ${input.outputName} as a stretch; validate setup cost before using more than ${formatMoney(spendCap)} of cash.`;
  }
  if (capitalFit === "unknown") {
    return `Confirm setup cost for ${input.outputName} before treating it as feasible.`;
  }
  if (setupCost !== undefined) {
    return `Grow cash or reduce setup cost before pursuing ${input.outputName}; estimated setup is ${formatMoney(setupCost)}.`;
  }
  return setupDistance === "unreachable_now" ? `Resolve prerequisites before pursuing ${input.outputName}.` : `Review prerequisites for ${input.outputName}.`;
}

function isResourceExtractionRecipe(building: BuildingInfo | undefined, outputName: string, inputCount?: number): boolean {
  const buildingName = `${building?.name ?? ""}`.toLowerCase();
  const output = outputName.toLowerCase();
  if (building?.industry === "Resource Extraction") return true;
  if (/\b(mine|extractor|drill|rig|quarry)\b/.test(buildingName)) return true;
  if (inputCount === 0 && /\bore\b/.test(output)) return true;
  return false;
}

function resourceAccessForRecipe(resourceRecipe: boolean, companyFit: ProfitabilityRecipe["companyFit"]): ResourceAccess {
  if (!resourceRecipe) return "available";
  if (companyFit === "active" || companyFit === "owned") return "owned";
  return "blocked";
}

function spendCapForRisk(cash: number, risk: PlayerPlanningContext["cashRiskLevel"]): number {
  const pct = risk === "conservative" ? 0.15 : risk === "aggressive" ? 0.5 : 0.3;
  return Math.max(0, round(cash * pct));
}

function practicalReserve(cash: number, risk: PlayerPlanningContext["cashRiskLevel"]): number {
  const pct = risk === "conservative" ? 0.25 : risk === "aggressive" ? 0.08 : 0.15;
  return Math.min(cash, Math.max(500_000, round(cash * pct)));
}

function capitalScore(capitalFit: CapitalFit | undefined, cashImpactPct: number | undefined): number {
  if (capitalFit === "affordable") return cashImpactPct !== undefined ? clamp(100 - cashImpactPct) : 92;
  if (capitalFit === "stretch") return 48;
  if (capitalFit === "blocked") return 12;
  if (capitalFit === "unknown") return 22;
  return 45;
}

function riskLabel(risk: PlayerPlanningContext["cashRiskLevel"]): string {
  if (risk === "conservative") return "conservative";
  if (risk === "aggressive") return "aggressive";
  return "balanced";
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
