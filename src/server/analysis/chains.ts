import type {
  CapitalFit,
  ChainOpportunity,
  PlayerPlanningContext,
  ProductionChain,
  ProductionChainStep,
  ProfitabilityRecipe,
  SetupCostCompleteness,
  SetupDistance
} from "../../shared/schemas.js";
import { clamp, formatMoney, formatPct, round } from "./utils.js";

type ChainResult = {
  chains: ProductionChain[];
  chainOpportunities: ChainOpportunity[];
};

const MAX_CHAIN_DEPTH = 3;

export function computeChainOpportunities(
  recipes: ProfitabilityRecipe[],
  context: PlayerPlanningContext
): ChainResult {
  const profitable = recipes.filter((recipe) => recipe.netEstimatePerHour > 0);
  const bestByOutput = new Map<number, ProfitabilityRecipe>();
  for (const recipe of profitable) {
    const current = bestByOutput.get(recipe.outputMatId);
    if (!current || recipe.netEstimatePerHour > current.netEstimatePerHour) bestByOutput.set(recipe.outputMatId, recipe);
  }

  const chains = uniqueChains(profitable
    .map((recipe) => buildChain(recipe, bestByOutput, new Set(), 0))
    .filter((steps) => steps.length > 1)
    .map((steps) => chainFromSteps(steps, context))
    .filter((chain): chain is ProductionChain => Boolean(chain)))
    .sort((a, b) => chainPriorityScore(b) - chainPriorityScore(a))
    .slice(0, 12);

  const maxProfit = Math.max(1, ...chains.map((chain) => chain.totalNetProfitPerHour));
  const chainOpportunities = chains
    .map((chain) => opportunityForChain(chain, maxProfit, context))
    .sort((a, b) => chainOpportunityPriority(b) - chainOpportunityPriority(a))
    .slice(0, 10);

  return { chains, chainOpportunities };
}

function buildChain(
  recipe: ProfitabilityRecipe,
  bestByOutput: Map<number, ProfitabilityRecipe>,
  seenRecipeIds: Set<number>,
  depth: number
): ProfitabilityRecipe[] {
  if (seenRecipeIds.has(recipe.recipeId) || depth >= MAX_CHAIN_DEPTH) return [recipe];
  const nextSeen = new Set(seenRecipeIds);
  nextSeen.add(recipe.recipeId);

  const upstream: ProfitabilityRecipe[] = [];
  for (const inputMatId of recipe.inputMatIds) {
    const supplier = bestByOutput.get(inputMatId);
    if (!supplier || supplier.recipeId === recipe.recipeId || nextSeen.has(supplier.recipeId)) continue;
    upstream.push(...buildChain(supplier, bestByOutput, nextSeen, depth + 1));
  }

  return uniqueRecipeSteps([...upstream, recipe]);
}

function chainFromSteps(steps: ProfitabilityRecipe[], context: PlayerPlanningContext): ProductionChain | undefined {
  const terminal = steps.at(-1);
  if (!terminal) return undefined;
  const setupGaps = uniqueStrings(steps.flatMap((step) => step.setupGaps));
  const missingPrerequisites = uniqueStrings(steps.flatMap((step) => step.missingPrerequisites ?? step.setupGaps));
  const unpricedRequirements = uniqueStrings(steps.flatMap((step) => step.unpricedRequirements ?? []));
  const blockingReasons = uniqueStrings(steps.flatMap((step) => step.blockingReasons ?? []));
  const warnings = uniqueStrings(steps.flatMap((step) => step.warnings));
  const totalInputCostPerHour = round(steps.reduce((sum, step) => sum + step.inputCostPerHour, 0));
  const totalOutputValuePerHour = round(terminal.outputValuePerHour);
  const totalNetProfitPerHour = round(terminal.netEstimatePerHour + steps.slice(0, -1).reduce((sum, step) => sum + Math.max(0, step.netEstimatePerHour) * 0.35, 0));
  const inputCoveragePct = round(steps.reduce((sum, step) => sum + step.inputCoveragePct, 0) / steps.length);
  const liquidityScore = terminal.liquidityScore;
  const marginPct = totalInputCostPerHour > 0 ? round((totalNetProfitPerHour / totalInputCostPerHour) * 100) : terminal.marginPct;
  const companyFit = chainFit(steps);
  const feasibility = chainFeasibility(steps, context);
  const confidence = confidenceForChain(inputCoveragePct, liquidityScore, setupGaps.length, terminal.priceConfidence, feasibility.capitalFit);

  return {
    id: `chain-${steps.map((step) => step.recipeId).join("-")}`,
    title: `${steps.map((step) => step.outputMatName).join(" -> ")}`,
    recipeIds: steps.map((step) => step.recipeId),
    outputMatId: terminal.outputMatId,
    outputMatName: terminal.outputMatName,
    steps: steps.map(chainStep),
    totalInputCostPerHour,
    totalOutputValuePerHour,
    totalNetProfitPerHour,
    marginPct,
    inputCoveragePct,
    liquidityScore,
    setupGaps,
    companyFit,
    capitalFit: feasibility.capitalFit,
    setupDistance: feasibility.setupDistance,
    resourceAccess: feasibility.resourceAccess,
    setupCostCompleteness: feasibility.setupCostCompleteness,
    setupCostEstimate: feasibility.setupCostEstimate,
    knownMinimumCapital: feasibility.knownMinimumCapital,
    knownCapitalGap: feasibility.knownCapitalGap,
    cashAfterSetup: feasibility.cashAfterSetup,
    cashImpactPct: feasibility.cashImpactPct,
    firstPracticalStep: feasibility.firstPracticalStep,
    missingPrerequisites,
    unpricedRequirements,
    blockingReasons,
    confidence,
    warnings
  };
}

function opportunityForChain(
  chain: ProductionChain,
  maxProfit: number,
  context: PlayerPlanningContext
): ChainOpportunity {
  const profitScore = clamp((chain.totalNetProfitPerHour / maxProfit) * 100);
  const fitScore = chain.companyFit === "active" ? 100 : chain.companyFit === "owned" ? 90 : chain.companyFit === "available" ? 62 : 36;
  const capitalScore = chain.capitalFit === "affordable" ? 92 : chain.capitalFit === "stretch" ? 48 : chain.capitalFit === "unknown" ? 22 : 10;
  const confidenceScore = chain.confidence === "high" ? 88 : chain.confidence === "medium" ? 62 : 34;
  const prompt = `${context.userPrompt ?? ""} ${context.shortTermGoal} ${context.notes ?? ""}`.toLowerCase();
  const goalBoost = /cv|value|profit|chain|speciali[sz]e|diversif|production/.test(prompt) ? 8 : 0;
  const riskPenalty = context.cashRiskLevel === "conservative" && chain.setupGaps.length > 0 ? 8 : 0;
  const score = round(profitScore * 0.28 + fitScore * 0.2 + capitalScore * 0.22 + chain.inputCoveragePct * 0.12 + chain.liquidityScore * 0.08 + confidenceScore * 0.1 + goalBoost - riskPenalty);
  const kind: ChainOpportunity["kind"] =
    chain.capitalFit === "blocked" || chain.capitalFit === "unknown"
      ? "restructure_chain"
      : chain.companyFit === "active" || chain.companyFit === "owned"
      ? chain.inputCoveragePct >= 85 ? "deepen_chain" : "stage_chain"
      : "restructure_chain";
  const horizon = kind === "deepen_chain"
    ? { id: "d1", label: "1 Day" }
    : kind === "stage_chain"
      ? { id: "d3", label: "3 Days" }
      : { id: "d7", label: "7 Days" };

  return {
    id: `chain-opportunity-${kind}-${chain.id}`,
    kind,
    chainId: chain.id,
    title: kind === "restructure_chain" ? `Restructure toward ${chain.outputMatName} chain` : `Optimize ${chain.outputMatName} chain`,
    recommendation: recommendationForChain(kind, chain),
    horizonId: horizon.id,
    horizonLabel: horizon.label,
    score,
    confidence: chain.confidence,
    profitPerHour: chain.totalNetProfitPerHour,
    marginPct: chain.marginPct,
    inputCoveragePct: chain.inputCoveragePct,
    capitalFit: chain.capitalFit,
    setupDistance: chain.setupDistance,
    resourceAccess: chain.resourceAccess,
    setupCostCompleteness: chain.setupCostCompleteness,
    setupCostEstimate: chain.setupCostEstimate,
    knownMinimumCapital: chain.knownMinimumCapital,
    knownCapitalGap: chain.knownCapitalGap,
    cashAfterSetup: chain.cashAfterSetup,
    cashImpactPct: chain.cashImpactPct,
    firstPracticalStep: chain.firstPracticalStep,
    missingPrerequisites: chain.missingPrerequisites,
    unpricedRequirements: chain.unpricedRequirements,
    blockingReasons: chain.blockingReasons,
    rationale: [
      `${formatMoney(chain.totalNetProfitPerHour)}/h chain net estimate${chain.marginPct !== undefined ? ` at ${formatPct(chain.marginPct)} margin` : ""}.`,
      `${chain.steps.length} linked production step(s): ${chain.steps.map((step) => step.outputMatName).join(" -> ")}.`,
      `${Math.round(chain.inputCoveragePct)}% visible input coverage and ${Math.round(chain.liquidityScore)} output liquidity score.`,
      chain.firstPracticalStep ?? "Confirm chain prerequisites before scaling."
    ],
    blockers: chain.missingPrerequisites ?? chain.setupGaps
  };
}

function chainStep(recipe: ProfitabilityRecipe): ProductionChainStep {
  return {
    recipeId: recipe.recipeId,
    recipeName: recipe.recipeName,
    outputMatId: recipe.outputMatId,
    outputMatName: recipe.outputMatName,
    buildingName: recipe.buildingName,
    netEstimatePerHour: recipe.netEstimatePerHour,
    marginPct: recipe.marginPct,
    companyFit: recipe.companyFit,
    capitalFit: recipe.capitalFit,
    setupDistance: recipe.setupDistance,
    resourceAccess: recipe.resourceAccess,
    setupCostCompleteness: recipe.setupCostCompleteness,
    knownMinimumCapital: recipe.knownMinimumCapital,
    knownCapitalGap: recipe.knownCapitalGap,
    unpricedRequirements: recipe.unpricedRequirements,
    blockingReasons: recipe.blockingReasons,
    setupGaps: recipe.setupGaps
  };
}

function chainFit(steps: ProfitabilityRecipe[]): ProductionChain["companyFit"] {
  if (steps.every((step) => step.companyFit === "active")) return "active";
  if (steps.every((step) => step.companyFit === "active" || step.companyFit === "owned")) return "owned";
  if (steps.every((step) => step.companyFit !== "target")) return "available";
  return "target";
}

function confidenceForChain(
  inputCoveragePct: number,
  liquidityScore: number,
  setupGapCount: number,
  terminalConfidence: ProfitabilityRecipe["priceConfidence"],
  capitalFit: CapitalFit | undefined
): ProductionChain["confidence"] {
  if (capitalFit === "blocked" || capitalFit === "unknown") return "low";
  if (terminalConfidence === "low" || setupGapCount >= 4 || liquidityScore < 25) return "low";
  if (inputCoveragePct >= 80 && liquidityScore >= 45 && setupGapCount <= 1 && terminalConfidence === "high") return "high";
  return "medium";
}

function recommendationForChain(kind: ChainOpportunity["kind"], chain: ProductionChain): string {
  if (kind === "deepen_chain") return `Deepen the existing ${chain.outputMatName} chain if live prices still support the linked steps.`;
  if (kind === "stage_chain") return `Stage missing inputs and facility checks before scaling the ${chain.outputMatName} chain.`;
  if (chain.capitalFit === "blocked" || chain.capitalFit === "unknown") return `Keep ${chain.outputMatName} as an aspirational chain until capital and setup blockers are cleared.`;
  return `Use ${chain.outputMatName} as a long-horizon restructure target only if setup gaps and liquidity checks stay favorable.`;
}

function chainFeasibility(steps: ProfitabilityRecipe[], context: PlayerPlanningContext): {
  capitalFit: CapitalFit;
  setupDistance: SetupDistance;
  resourceAccess?: ProductionChain["resourceAccess"];
  setupCostCompleteness?: SetupCostCompleteness;
  setupCostEstimate?: number;
  knownMinimumCapital?: number;
  knownCapitalGap?: number;
  cashAfterSetup?: number;
  cashImpactPct?: number;
  firstPracticalStep: string;
} {
  const cash = inferCash(steps);
  const costs = steps.map((step) => step.setupCostEstimate).filter((value): value is number => value !== undefined);
  const hasUnknownCost = steps.some((step) => step.capitalFit === "unknown" || step.setupCostCompleteness === "unknown" || step.setupCostEstimate === undefined);
  const hasPartialCost = steps.some((step) => step.setupCostCompleteness === "partial");
  const hasBlockingReason = steps.some((step) => (step.blockingReasons ?? []).length > 0);
  const setupCostEstimate = costs.length > 0 ? round(costs.reduce((sum, cost) => sum + Math.max(0, cost), 0)) : hasUnknownCost ? undefined : 0;
  const spendCap = cash !== undefined ? spendCapForRisk(cash, context.cashRiskLevel) : undefined;
  const reserve = cash !== undefined ? practicalReserve(cash, context.cashRiskLevel) : undefined;
  const knownMinimumCapital = cash !== undefined && reserve !== undefined && setupCostEstimate !== undefined ? round(setupCostEstimate + reserve) : undefined;
  const knownCapitalGap = cash !== undefined && knownMinimumCapital !== undefined ? Math.max(0, round(knownMinimumCapital - cash)) : undefined;
  const cashAfterSetup = cash !== undefined && setupCostEstimate !== undefined ? round(cash - setupCostEstimate) : undefined;
  const cashImpactPct = cash !== undefined && cash > 0 && setupCostEstimate !== undefined ? round((setupCostEstimate / cash) * 100) : undefined;
  const firstBlockedStep = steps.find((step) => step.capitalFit === "blocked" || step.capitalFit === "unknown" || step.setupDistance !== "ready");
  let capitalFit: CapitalFit;
  const setupCostCompleteness: SetupCostCompleteness = hasUnknownCost ? "unknown" : hasPartialCost || hasBlockingReason ? "partial" : "complete";
  const resourceAccess: ProductionChain["resourceAccess"] = steps.some((step) => step.resourceAccess === "blocked")
    ? "blocked"
    : steps.some((step) => step.resourceAccess === "unknown") ? "unknown"
      : steps.some((step) => step.resourceAccess === "owned") ? "owned" : "available";

  if (hasBlockingReason) {
    capitalFit = "blocked";
  } else if (hasUnknownCost) {
    capitalFit = "unknown";
  } else if (cash === undefined || setupCostEstimate === undefined || spendCap === undefined || reserve === undefined) {
    capitalFit = "unknown";
  } else if (setupCostEstimate <= spendCap && cashAfterSetup !== undefined && cashAfterSetup >= reserve) {
    capitalFit = "affordable";
  } else if (setupCostEstimate <= cash && cashAfterSetup !== undefined && cashAfterSetup >= reserve * 0.5) {
    capitalFit = "stretch";
  } else {
    capitalFit = "blocked";
  }

  const setupDistance: SetupDistance = capitalFit === "blocked" || capitalFit === "unknown"
    ? "unreachable_now"
    : steps.every((step) => step.setupDistance === "ready") ? "ready"
      : steps.filter((step) => step.setupDistance !== "ready").length <= 1 ? "one_step" : "multi_step";

  return {
    capitalFit,
    setupDistance,
    resourceAccess,
    setupCostCompleteness,
    setupCostEstimate,
    knownMinimumCapital,
    knownCapitalGap,
    cashAfterSetup,
    cashImpactPct,
    firstPracticalStep: firstBlockedStep?.firstPracticalStep ?? `Validate every linked step before scaling ${steps.at(-1)?.outputMatName ?? "this chain"}.`
  };
}

function inferCash(steps: ProfitabilityRecipe[]): number | undefined {
  for (const step of steps) {
    if (step.cashAfterSetup !== undefined && step.setupCostEstimate !== undefined) return step.cashAfterSetup + step.setupCostEstimate;
  }
  return undefined;
}

function spendCapForRisk(cash: number, risk: PlayerPlanningContext["cashRiskLevel"]): number {
  const pct = risk === "conservative" ? 0.15 : risk === "aggressive" ? 0.5 : 0.3;
  return Math.max(0, round(cash * pct));
}

function practicalReserve(cash: number, risk: PlayerPlanningContext["cashRiskLevel"]): number {
  const pct = risk === "conservative" ? 0.25 : risk === "aggressive" ? 0.08 : 0.15;
  return Math.min(cash, Math.max(500_000, round(cash * pct)));
}

function chainPriorityScore(chain: ProductionChain): number {
  const capital = chain.capitalFit === "affordable" ? 120 : chain.capitalFit === "stretch" ? 70 : chain.capitalFit === "unknown" ? 20 : 0;
  const distance = chain.setupDistance === "ready" ? 40 : chain.setupDistance === "one_step" ? 30 : chain.setupDistance === "multi_step" ? 15 : 0;
  return capital + distance + chain.totalNetProfitPerHour / 100_000 + chain.inputCoveragePct / 5;
}

function chainOpportunityPriority(opportunity: ChainOpportunity): number {
  const capital = opportunity.capitalFit === "affordable" ? 120 : opportunity.capitalFit === "stretch" ? 70 : opportunity.capitalFit === "unknown" ? 20 : 0;
  const distance = opportunity.setupDistance === "ready" ? 40 : opportunity.setupDistance === "one_step" ? 30 : opportunity.setupDistance === "multi_step" ? 15 : 0;
  return capital + distance + opportunity.score;
}

function uniqueChains(chains: ProductionChain[]): ProductionChain[] {
  const seen = new Set<string>();
  const unique: ProductionChain[] = [];
  for (const chain of chains) {
    const key = chain.recipeIds.join("-");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(chain);
  }
  return unique;
}

function uniqueRecipeSteps(steps: ProfitabilityRecipe[]): ProfitabilityRecipe[] {
  const byId = new Map<number, ProfitabilityRecipe>();
  for (const step of steps) byId.set(step.recipeId, step);
  return [...byId.values()];
}

function uniqueStrings(items: Array<string | undefined>): string[] {
  return [...new Set(items.filter((item): item is string => Boolean(item && item.trim())))];
}
