import type {
  GameSnapshot,
  PreparedCommand,
  ProfitabilityRecipe,
  WhatIfScenarioRequest,
  WhatIfScenarioResult
} from "../shared/schemas.js";
import { buildDeterministicSitrep } from "./analysis.js";
import { materialId, materialQuantity } from "./analysis/normalizers.js";
import { formatMoney, numberValue, recordArray, round, text } from "./analysis/utils.js";

export function evaluateWhatIf(snapshot: GameSnapshot, request: WhatIfScenarioRequest): WhatIfScenarioResult {
  const baselineSitrep = buildDeterministicSitrep(snapshot, request.planningContext, "openai", "what-if");
  const cash = baselineSitrep.situation?.cash.current ?? numberValue(snapshot.company.cash) ?? 0;
  const baselineProfit = baselineSitrep.profitability?.companyFit[0]?.profitPerHour ?? 0;
  const blockers: string[] = [];
  const warnings = [...snapshot.warnings];

  const targetRecipe = findScenarioRecipe(request, baselineSitrep.profitability?.recipes ?? []);
  const targetMaterialId = request.matId ?? baselineSitrep.stockoutRisks[0]?.matId ?? targetRecipe?.inputMatIds[0] ?? baselineSitrep.marketSignals[0]?.matId;
  const targetMaterialName = targetMaterialId ? materialName(snapshot, targetMaterialId) : "selected material";
  const quantity = request.quantity ?? defaultQuantity(request, baselineSitrep, targetRecipe, targetMaterialId);
  const unitPrice = targetMaterialId ? priceForMaterial(snapshot, targetMaterialId) : undefined;

  let title = "Compare scenario against the baseline";
  let summary = "Scenario uses the latest read-only snapshot and deterministic profitability model.";
  let cashDelta = 0;
  let profitDelta = 0;
  const materialDeltas: WhatIfScenarioResult["deltas"]["materials"] = [];
  const productionImpact: string[] = [];
  let risk: WhatIfScenarioResult["scenario"]["risk"] = "medium";
  let preparedCommands: PreparedCommand[] = [];

  if (request.scenarioType === "buy_material" || request.scenarioType === "increase_buffer") {
    if (!targetMaterialId) blockers.push("No material was selected and no stockout/material signal was available.");
    if (!unitPrice) blockers.push(`No price was available for ${targetMaterialName}.`);
    const cost = unitPrice && quantity > 0 ? round(unitPrice * quantity) : request.cashSpend ?? 0;
    cashDelta = -cost;
    materialDeltas.push({ matId: targetMaterialId ?? 0, matName: targetMaterialName, quantityDelta: round(quantity), cashDelta });
    const recipeUse = bestRecipeUsingMaterial(targetMaterialId, baselineSitrep.profitability?.recipes ?? []);
    profitDelta = recipeUse ? Math.max(0, recipeUse.netEstimatePerHour - baselineProfit) : 0;
    title = request.scenarioType === "increase_buffer" ? `Increase ${targetMaterialName} buffer` : `Buy ${targetMaterialName}`;
    summary = `Adds ${Math.ceil(quantity).toLocaleString()} ${targetMaterialName} for about ${formatMoney(cost)} before live order-book changes.`;
    productionImpact.push(recipeUse ? `Supports ${recipeUse.outputMatName} at ${formatMoney(recipeUse.netEstimatePerHour)}/h estimated net.` : "No direct profitable recipe dependency was identified.");
    risk = cashDelta < -cash * 0.25 ? "high" : recipeUse ? "medium" : "low";
    preparedCommands = targetMaterialId ? [buyCommand(targetMaterialName, targetMaterialId, Math.ceil(quantity))] : [];
  }

  if (request.scenarioType === "start_recipe" || request.scenarioType === "switch_production") {
    if (!targetRecipe) blockers.push("No recipe was selected and no profitability target was available.");
    if (targetRecipe) {
      profitDelta = round(targetRecipe.netEstimatePerHour - baselineProfit);
      cashDelta = 0;
      title = request.scenarioType === "switch_production" ? `Switch production to ${targetRecipe.outputMatName}` : `Start ${targetRecipe.outputMatName}`;
      summary = `${targetRecipe.recipeName} is estimated at ${formatMoney(targetRecipe.netEstimatePerHour)}/h before omitted shipping and maintenance assumptions.`;
      productionImpact.push(...[
        `${Math.round(targetRecipe.inputCoveragePct)}% one-run input coverage.`,
        `${Math.round(targetRecipe.liquidityScore)} output liquidity score.`,
        ...targetRecipe.setupGaps
      ]);
      blockers.push(...targetRecipe.setupGaps);
      risk = targetRecipe.priceConfidence === "low" || targetRecipe.setupGaps.length > 2 ? "high" : targetRecipe.setupGaps.length > 0 ? "medium" : "low";
      preparedCommands = [recipeCommand(targetRecipe, request.scenarioType)];
    }
  }

  if (request.scenarioType === "stage_inputs" || request.scenarioType === "build_expansion") {
    if (!targetRecipe) blockers.push("No recipe target was available for staging or expansion.");
    if (targetRecipe) {
      const estimatedSpend = request.cashSpend ?? targetRecipe.setupCostEstimate ?? targetRecipe.inputCostPerHour;
      cashDelta = -round(estimatedSpend);
      profitDelta = request.scenarioType === "stage_inputs" ? Math.max(0, targetRecipe.netEstimatePerHour - baselineProfit) : targetRecipe.netEstimatePerHour;
      title = request.scenarioType === "stage_inputs" ? `Stage inputs for ${targetRecipe.outputMatName}` : `Build toward ${targetRecipe.outputMatName}`;
      summary = `Uses about ${formatMoney(estimatedSpend)} to prepare a ${formatMoney(targetRecipe.netEstimatePerHour)}/h recipe lane.`;
      productionImpact.push(...[
        `${targetRecipe.buildingName ?? "Production building"} requirement should be checked live.`,
        `${Math.round(targetRecipe.inputCoveragePct)}% visible input coverage.`,
        `${Math.round(targetRecipe.liquidityScore)} output liquidity score.`
      ]);
      blockers.push(...targetRecipe.setupGaps);
      risk = cashDelta < -cash * 0.35 || targetRecipe.setupGaps.length > 2 ? "high" : "medium";
      preparedCommands = [recipeCommand(targetRecipe, request.scenarioType)];
    }
  }

  if (cash + cashDelta < 0) blockers.push("Scenario would exceed visible cash.");
  if (cashDelta < -cash * 0.4 && request.planningContext.cashRiskLevel !== "aggressive") {
    blockers.push("Cash impact is large for the selected risk level.");
  }

  const recommendedChoice = chooseScenario(cash, cashDelta, profitDelta, blockers, request.scenarioType);

  return {
    generatedAt: new Date().toISOString(),
    scenarioType: request.scenarioType,
    title,
    baseline: {
      title: "Current baseline",
      summary: baselineSitrep.summary,
      cash,
      cashDisplay: formatMoney(cash),
      profitPerHour: baselineProfit,
      profitPerHourDisplay: `${formatMoney(baselineProfit)}/h`,
      materialDeltas: [],
      productionImpact: baselineSitrep.actionPlans.slice(0, 3).map((plan) => plan.title),
      risk: baselineSitrep.situation?.production.status === "critical" ? "critical" : baselineSitrep.situation?.production.status === "high" ? "high" : "low",
      blockers: baselineSitrep.warnings.slice(0, 4)
    },
    scenario: {
      title,
      summary,
      cash: cash + cashDelta,
      cashDisplay: formatMoney(cash + cashDelta),
      profitPerHour: baselineProfit + profitDelta,
      profitPerHourDisplay: `${formatMoney(baselineProfit + profitDelta)}/h`,
      materialDeltas,
      productionImpact,
      risk,
      blockers: uniqueStrings(blockers)
    },
    deltas: {
      cash: cashDelta,
      profitPerHour: profitDelta,
      materials: materialDeltas
    },
    recommendedChoice,
    rationale: scenarioRationale(recommendedChoice, cashDelta, profitDelta, blockers),
    blockers: uniqueStrings(blockers),
    preparedCommands,
    warnings
  };
}

function findScenarioRecipe(request: WhatIfScenarioRequest, recipes: ProfitabilityRecipe[]): ProfitabilityRecipe | undefined {
  if (request.recipeId) return recipes.find((recipe) => recipe.recipeId === request.recipeId);
  return recipes.find((recipe) => recipe.companyFit !== "target" && recipe.netEstimatePerHour > 0) ?? recipes[0];
}

function bestRecipeUsingMaterial(matId: number | undefined, recipes: ProfitabilityRecipe[]): ProfitabilityRecipe | undefined {
  if (!matId) return undefined;
  return recipes
    .filter((recipe) => recipe.inputMatIds.includes(matId))
    .sort((a, b) => b.netEstimatePerHour - a.netEstimatePerHour)[0];
}

function defaultQuantity(
  request: WhatIfScenarioRequest,
  sitrep: ReturnType<typeof buildDeterministicSitrep>,
  recipe: ProfitabilityRecipe | undefined,
  matId: number | undefined
): number {
  const matchingRisk = matId ? sitrep.stockoutRisks.find((risk) => risk.matId === matId) : undefined;
  const matchingNeed = matId ? sitrep.projections.materialNeeds.find((need) => need.matId === matId && need.netNeedQty > 0) : undefined;
  if (request.bufferHours && matchingNeed) return Math.ceil((matchingNeed.netNeedQty / matchingNeed.hours) * request.bufferHours);
  if (matchingRisk) return Math.ceil(matchingRisk.shortageQty);
  if (matchingNeed) return Math.ceil(matchingNeed.netNeedQty);
  if (recipe?.inputMatIds.includes(matId ?? -1)) return 100;
  return 1;
}

function chooseScenario(
  cash: number,
  cashDelta: number,
  profitDelta: number,
  blockers: string[],
  scenarioType: WhatIfScenarioRequest["scenarioType"]
): WhatIfScenarioResult["recommendedChoice"] {
  if (blockers.length > 0) return "defer";
  if (cash + cashDelta < 0) return "baseline";
  if (scenarioType === "buy_material" || scenarioType === "increase_buffer") return cashDelta < 0 ? "scenario" : "defer";
  if (profitDelta > 0) return "scenario";
  return "baseline";
}

function scenarioRationale(
  choice: WhatIfScenarioResult["recommendedChoice"],
  cashDelta: number,
  profitDelta: number,
  blockers: string[]
): string[] {
  if (choice === "scenario") {
    return uniqueStrings([
      profitDelta > 0 ? `Scenario improves projected production profit by ${formatMoney(profitDelta)}/h.` : undefined,
      cashDelta < 0 ? `Scenario spends about ${formatMoney(Math.abs(cashDelta))}.` : "Scenario has no immediate cash draw in this model.",
      "Execute manually only after live GT screens still match this snapshot."
    ]);
  }
  if (choice === "defer") {
    return uniqueStrings([
      "Defer until blockers are resolved.",
      ...blockers.slice(0, 3)
    ]);
  }
  return ["Baseline is safer because the scenario does not improve projected profit enough to justify the risk."];
}

function priceForMaterial(snapshot: GameSnapshot, matId: number): number | undefined {
  for (const item of [...snapshot.market.details, ...snapshot.market.prices]) {
    const candidateId = numberValue(item.matId) ?? numberValue(item.id);
    if (candidateId !== matId) continue;
    const price = numberValue(item.currentPrice);
    if (price && price > 0) return price;
  }
  for (const material of recordArray(snapshot.gameData.materials)) {
    const candidateId = numberValue(material.id);
    if (candidateId !== matId) continue;
    const price = numberValue(material.cp);
    if (price && price > 0) return price;
  }
  return undefined;
}

function materialName(snapshot: GameSnapshot, matId: number): string {
  for (const item of [...recordArray(snapshot.gameData.materials), ...snapshot.market.details, ...snapshot.market.prices]) {
    const candidateId = numberValue(item.matId) ?? numberValue(item.id) ?? materialId(item);
    if (candidateId === matId) return text(item.matName) || text(item.name) || `Material ${matId}`;
  }
  return `Material ${matId}`;
}

function buyCommand(matName: string, matId: number, quantity: number): PreparedCommand {
  return {
    type: "buy_material",
    title: `Buy ${matName}`,
    executable: false,
    payload: { matId, quantity },
    steps: [
      `Open ${matName} on the Galactic Exchange.`,
      `Confirm at least ${quantity.toLocaleString()} units are still available near the snapshot price.`,
      "Buy manually only if the cash and buffer tradeoff still fits."
    ]
  };
}

function recipeCommand(recipe: ProfitabilityRecipe, scenarioType: WhatIfScenarioRequest["scenarioType"]): PreparedCommand {
  return {
    type: scenarioType === "start_recipe" || scenarioType === "switch_production" ? "start_production" : "review",
    title: `Review ${recipe.outputMatName} scenario`,
    executable: false,
    payload: { recipeId: recipe.recipeId, scenarioType },
    steps: [
      `Open the recipe for ${recipe.outputMatName}.`,
      "Refresh live input and output prices.",
      "Confirm facility, research, input coverage, warehouse room, and output depth.",
      ...recipe.setupGaps.map((gap) => `Resolve: ${gap}`)
    ]
  };
}

function uniqueStrings(items: Array<string | undefined>): string[] {
  return [...new Set(items.filter((item): item is string => Boolean(item && item.trim())))];
}
