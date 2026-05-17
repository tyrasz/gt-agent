import type {
  ChainOpportunity,
  PlayerPlanningContext,
  ProductionChain,
  ProductionChainStep,
  ProfitabilityRecipe
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
    .map((steps) => chainFromSteps(steps))
    .filter((chain): chain is ProductionChain => Boolean(chain)))
    .sort((a, b) => b.totalNetProfitPerHour - a.totalNetProfitPerHour || b.inputCoveragePct - a.inputCoveragePct)
    .slice(0, 12);

  const maxProfit = Math.max(1, ...chains.map((chain) => chain.totalNetProfitPerHour));
  const chainOpportunities = chains
    .map((chain) => opportunityForChain(chain, maxProfit, context))
    .sort((a, b) => b.score - a.score)
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

function chainFromSteps(steps: ProfitabilityRecipe[]): ProductionChain | undefined {
  const terminal = steps.at(-1);
  if (!terminal) return undefined;
  const setupGaps = uniqueStrings(steps.flatMap((step) => step.setupGaps));
  const warnings = uniqueStrings(steps.flatMap((step) => step.warnings));
  const totalInputCostPerHour = round(steps.reduce((sum, step) => sum + step.inputCostPerHour, 0));
  const totalOutputValuePerHour = round(terminal.outputValuePerHour);
  const totalNetProfitPerHour = round(terminal.netEstimatePerHour + steps.slice(0, -1).reduce((sum, step) => sum + Math.max(0, step.netEstimatePerHour) * 0.35, 0));
  const inputCoveragePct = round(steps.reduce((sum, step) => sum + step.inputCoveragePct, 0) / steps.length);
  const liquidityScore = terminal.liquidityScore;
  const marginPct = totalInputCostPerHour > 0 ? round((totalNetProfitPerHour / totalInputCostPerHour) * 100) : terminal.marginPct;
  const companyFit = chainFit(steps);
  const confidence = confidenceForChain(inputCoveragePct, liquidityScore, setupGaps.length, terminal.priceConfidence);

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
  const confidenceScore = chain.confidence === "high" ? 88 : chain.confidence === "medium" ? 62 : 34;
  const prompt = `${context.userPrompt ?? ""} ${context.shortTermGoal} ${context.notes ?? ""}`.toLowerCase();
  const goalBoost = /cv|value|profit|chain|speciali[sz]e|diversif|production/.test(prompt) ? 8 : 0;
  const riskPenalty = context.cashRiskLevel === "conservative" && chain.setupGaps.length > 0 ? 8 : 0;
  const score = round(profitScore * 0.38 + fitScore * 0.22 + chain.inputCoveragePct * 0.16 + chain.liquidityScore * 0.12 + confidenceScore * 0.12 + goalBoost - riskPenalty);
  const kind: ChainOpportunity["kind"] =
    chain.companyFit === "active" || chain.companyFit === "owned"
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
    rationale: [
      `${formatMoney(chain.totalNetProfitPerHour)}/h chain net estimate${chain.marginPct !== undefined ? ` at ${formatPct(chain.marginPct)} margin` : ""}.`,
      `${chain.steps.length} linked production step(s): ${chain.steps.map((step) => step.outputMatName).join(" -> ")}.`,
      `${Math.round(chain.inputCoveragePct)}% visible input coverage and ${Math.round(chain.liquidityScore)} output liquidity score.`
    ],
    blockers: chain.setupGaps
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
  terminalConfidence: ProfitabilityRecipe["priceConfidence"]
): ProductionChain["confidence"] {
  if (terminalConfidence === "low" || setupGapCount >= 4 || liquidityScore < 25) return "low";
  if (inputCoveragePct >= 80 && liquidityScore >= 45 && setupGapCount <= 1 && terminalConfidence === "high") return "high";
  return "medium";
}

function recommendationForChain(kind: ChainOpportunity["kind"], chain: ProductionChain): string {
  if (kind === "deepen_chain") return `Deepen the existing ${chain.outputMatName} chain if live prices still support the linked steps.`;
  if (kind === "stage_chain") return `Stage missing inputs and facility checks before scaling the ${chain.outputMatName} chain.`;
  return `Use ${chain.outputMatName} as a long-horizon restructure target only if setup gaps and liquidity checks stay favorable.`;
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
