import { describe, expect, it } from "vitest";
import type { GameSnapshot } from "../../shared/schemas.js";
import { analyzeSnapshot, buildDeterministicSitrep } from "../analysis.js";
import { normalizeSnapshot } from "../analysis/normalizers.js";
import { computeProfitability } from "../analysis/profitability.js";
import { classifyPlanningIntent } from "../analysis/strategy.js";
import { makeSnapshot } from "./fixtures.js";

const context = {
  autonomyHours: 12,
  cashRiskLevel: "balanced" as const,
  shortTermGoal: "Keep production running"
};

describe("analysis", () => {
  it("classifies planning intent from the player prompt and context", () => {
    expect(classifyPlanningIntent({ ...context, userPrompt: "How do I increase my CV?" })).toBe("cv_growth");
    expect(classifyPlanningIntent({ ...context, userPrompt: "Find market profit and repricing moves." })).toBe("market_profit");
    expect(classifyPlanningIntent({ ...context, userPrompt: "Restock inputs before my next login." })).toBe("production_stability");
    expect(classifyPlanningIntent({ ...context, userPrompt: "Plan ship cargo transfers." })).toBe("logistics");
    expect(classifyPlanningIntent({ ...context, userPrompt: "Should I expand a base?" })).toBe("expansion");
    expect(classifyPlanningIntent({ ...context, userPrompt: "Audit risk before spending." })).toBe("risk_review");
    expect(classifyPlanningIntent({ ...context, shortTermGoal: "Assess current state", userPrompt: "Give me a sitrep." })).toBe("general_sitrep");
  });

  it("computes market signals and stockout-driven action plans", () => {
    const result = analyzeSnapshot(makeSnapshot(), context);

    expect(result.marketSignals.some((signal) => signal.matName === "Iron Ore" && signal.recommendation === "buy")).toBe(true);
    expect(result.stockoutRisks.some((risk) => risk.matName === "Iron Ore")).toBe(true);
    expect(result.actionPlans[0]?.score).toBeTypeOf("number");
    expect(result.actionPlans[0]?.confidence).toMatch(/low|medium|high/);
    expect(result.actionPlans[0]?.whyNow).toBeTruthy();
    expect(result.actionPlans[0]?.preparedCommands.every((command) => command.executable === false)).toBe(true);
  });

  it("builds a complete deterministic sitrep with a raw snapshot", () => {
    const sitrep = buildDeterministicSitrep(makeSnapshot(), context, "openai", "test-model");

    expect(sitrep.provider).toBe("openai");
    expect(sitrep.model).toBe("test-model");
    expect(sitrep.rawSnapshot?.company.name).toBe("Stellar Foundry");
    expect(sitrep.actionPlans.length).toBeGreaterThan(0);
    expect(sitrep.situation?.production.summary).toContain("material risks");
    expect(sitrep.decisionBrief.thesis).toContain("Stellar Foundry");
    expect(sitrep.decisionBrief.recommendedPath.length).toBeGreaterThan(0);
    expect(sitrep.projections.horizons.map((horizon) => horizon.hours)).toEqual([12, 24, 72, 168]);
    expect(sitrep.marketSignals[0]).toHaveProperty("liquidityScore");
    expect(sitrep.profitability?.companyFit.length).toBeGreaterThan(0);
    expect(sitrep.profitability?.globalTargets.length).toBeGreaterThan(0);
  });

  it("computes recipe profitability from market prices and CP fallback", () => {
    const snapshot = makeSnapshot();
    const normalized = normalizeSnapshot(snapshot, context);
    const profitability = computeProfitability(snapshot, normalized, context);
    const ironBar = profitability.recipes.find((recipe) => recipe.outputMatName === "Iron Bar");
    const tools = profitability.recipes.find((recipe) => recipe.outputMatName === "Tools");

    expect(ironBar).toMatchObject({
      inputCostPerHour: 400_000,
      outputValuePerHour: 600_000,
      grossProfitPerHour: 200_000,
      netEstimatePerHour: 200_000,
      marginPct: 50,
      priceConfidence: "high"
    });
    expect(tools?.outputValuePerHour).toBe(600_000);
    expect(tools?.warnings.join(" ")).toContain("CP fallback");
    expect(tools?.priceConfidence).toBe("low");
  });

  it("keeps company-fit profit opportunities ahead of global restructure targets", () => {
    const sitrep = buildDeterministicSitrep({
      ...makeSnapshot(),
      wishlists: []
    }, { ...context, userPrompt: "How do I increase CV through profit?" }, "openai", "test-model");

    expect(sitrep.profitability?.companyFit[0]?.title).toContain("Iron Bar");
    expect(sitrep.profitability?.globalTargets[0]?.title).toContain("Tools");
    const companyPlanIndex = sitrep.actionPlans.findIndex((plan) => plan.title.includes("Iron Bar") && plan.category === "profitability");
    const globalPlanIndex = sitrep.actionPlans.findIndex((plan) => plan.title.includes("Tools") && plan.category === "profitability");
    expect(companyPlanIndex).toBeGreaterThanOrEqual(0);
    expect(globalPlanIndex).toBeGreaterThanOrEqual(0);
    expect(companyPlanIndex).toBeLessThan(globalPlanIndex);
  });

  it("projects material needs per horizon without mutating the snapshot", () => {
    const snapshot = cloneSnapshot(makeSnapshot());
    snapshot.wishlists = [];
    snapshot.warehouses[0].mats = [{ id: 1, qty: 250 }];
    const before = JSON.stringify(snapshot);

    const sitrep = buildDeterministicSitrep(snapshot, context, "openai", "test-model");
    const next12 = sitrep.projections.materialNeeds.find((need) => need.horizonId === "h12" && need.matName === "Iron Ore");
    const day3 = sitrep.projections.materialNeeds.find((need) => need.horizonId === "d3" && need.matName === "Iron Ore");

    expect(next12?.requiredQty).toBe(100);
    expect(next12?.netNeedQty).toBe(0);
    expect(day3?.requiredQty).toBe(600);
    expect(day3?.netNeedQty).toBe(350);
    expect(JSON.stringify(snapshot)).toBe(before);
  });

  it("surfaces a 3-day shortage while keeping the 12-hour band stable", () => {
    const snapshot = cloneSnapshot(makeSnapshot());
    snapshot.wishlists = [];
    snapshot.warehouses[0].mats = [{ id: 1, qty: 250 }];

    const sitrep = buildDeterministicSitrep(snapshot, context, "openai", "test-model");
    const day3 = sitrep.projections.bands.find((band) => band.horizonId === "d3");

    expect(sitrep.stockoutRisks.some((risk) => risk.matName === "Iron Ore")).toBe(false);
    expect(day3?.materialNeeds.some((need) => need.matName === "Iron Ore" && need.netNeedQty > 0)).toBe(true);
    expect(sitrep.actionPlans.some((plan) => plan.title === "Prepare Iron Ore coverage for 3 Days")).toBe(true);
  });

  it("keeps urgent 12-hour blockers ranked ahead of future projected work", () => {
    const sitrep = buildDeterministicSitrep(makeSnapshot(), context, "openai", "test-model");
    const firstProjectedIndex = sitrep.actionPlans.findIndex((plan) => plan.id.startsWith("project-restock-"));
    const immediateIndex = sitrep.actionPlans.findIndex((plan) => plan.id === "restock-1");

    expect(immediateIndex).toBeGreaterThanOrEqual(0);
    if (firstProjectedIndex >= 0) expect(immediateIndex).toBeLessThan(firstProjectedIndex);
    expect(sitrep.actionPlans[immediateIndex]?.horizonLabel).toBe("Next 12h");
  });

  it("uses cash-risk preference to change long-horizon projected buy scores", () => {
    const snapshot = cloneSnapshot(makeSnapshot());
    snapshot.wishlists = [];
    snapshot.warehouses[0].mats = [{ id: 1, qty: 250 }];

    const conservative = buildDeterministicSitrep(snapshot, { ...context, cashRiskLevel: "conservative" }, "openai", "test-model");
    const aggressive = buildDeterministicSitrep(snapshot, { ...context, cashRiskLevel: "aggressive" }, "openai", "test-model");
    const conservativePlan = conservative.actionPlans.find((plan) => plan.title === "Prepare Iron Ore coverage for 3 Days");
    const aggressivePlan = aggressive.actionPlans.find((plan) => plan.title === "Prepare Iron Ore coverage for 3 Days");

    expect(aggressivePlan?.score ?? 0).toBeGreaterThan(conservativePlan?.score ?? 0);
  });

  it("adds projection warnings when long-range data is incomplete", () => {
    const sitrep = buildDeterministicSitrep(makeSnapshot(), context, "openai", "test-model");

    expect(sitrep.projections.warnings.join(" ")).toContain("Base-plan material requirements");
  });

  it("shapes CV growth prompts into deepen-vs-diversify decision briefs", () => {
    const sitrep = buildDeterministicSitrep(makeSnapshot(), {
      ...context,
      userPrompt: "Give me next steps to increase my CV.",
      notes: "Should I deepen Agri 4 or diversify?"
    }, "openai", "test-model");

    expect(sitrep.decisionBrief.thesis).toMatch(/CV|value/i);
    expect(sitrep.decisionBrief.recommendedPath.join(" ")).toMatch(/specialization|diversification|diversify/i);
    expect(sitrep.decisionBrief.alternatives.map((item) => item.title).join(" ")).toMatch(/Deepen .*Iron Bar/);
    expect(sitrep.decisionBrief.alternatives.map((item) => item.title).join(" ")).toMatch(/Diversify .*Tools/);
    expect(sitrep.decisionBrief.inspectNext.join(" ")).toContain("CV growth");
    expect(sitrep.actionPlans[0]?.bestWhen).toBeTruthy();
    expect(sitrep.actionPlans[0]?.avoidIf).toBeTruthy();
    expect(sitrep.actionPlans[0]?.whatWouldChangeThis).toBeTruthy();
  });

  it("does not rank a cheap material buy when the company has no demand or recipe use", () => {
    const snapshot = cloneSnapshot(makeSnapshot());
    snapshot.gameData.materials = [
      ...(snapshot.gameData.materials as Record<string, unknown>[]),
      { id: 30, name: "Copper Dust", weight: 1, cp: 300 }
    ];
    snapshot.market.prices.push({ matId: 30, matName: "Copper Dust", currentPrice: 100, avgPrice: 500 });
    snapshot.market.details.push({
      matId: 30,
      matName: "Copper Dust",
      currentPrice: 100,
      avgPrice: 500,
      totalQtyAvailable: 50_000,
      avgQtySoldDaily: 5_000,
      priceHistory: [
        { avgPrice: 100, qtySold: 5_000 },
        { avgPrice: 500, qtySold: 4_000 }
      ]
    });

    const result = analyzeSnapshot(snapshot, context);
    const copper = result.marketSignals.find((signal) => signal.matName === "Copper Dust");

    expect(copper?.recommendation).toBe("watch");
    expect(result.actionPlans.some((plan) => plan.title === "Buy Copper Dust")).toBe(false);
  });

  it("ranks immediate stockout coverage ahead of profitable repricing", () => {
    const result = analyzeSnapshot(makeSnapshot(), context);
    const restockIndex = result.actionPlans.findIndex((plan) => plan.title === "Restock Iron Ore");
    const repriceIndex = result.actionPlans.findIndex((plan) => plan.title === "Reprice Iron Bar");

    expect(restockIndex).toBeGreaterThanOrEqual(0);
    expect(repriceIndex).toBeGreaterThanOrEqual(0);
    expect(restockIndex).toBeLessThan(repriceIndex);
  });

  it("requires owned inventory or an exchange order before repricing a market material", () => {
    const snapshot = cloneSnapshot(makeSnapshot());
    snapshot.gameData.materials = [
      ...(snapshot.gameData.materials as Record<string, unknown>[]),
      { id: 4, name: "Platinum Foam", weight: 1, cp: 1000 }
    ];
    snapshot.market.prices.push({ matId: 4, matName: "Platinum Foam", currentPrice: 5000, avgPrice: 1000 });
    snapshot.market.details.push({
      matId: 4,
      matName: "Platinum Foam",
      currentPrice: 5000,
      avgPrice: 1000,
      totalQtyAvailable: 1000,
      avgQtySoldDaily: 1000,
      priceHistory: [
        { avgPrice: 5000, qtySold: 1000 },
        { avgPrice: 1000, qtySold: 900 }
      ]
    });

    const result = analyzeSnapshot(snapshot, context);

    expect(result.marketSignals.find((signal) => signal.matName === "Platinum Foam")?.recommendation).toBe("watch");
    expect(result.actionPlans.some((plan) => plan.title === "Reprice Platinum Foam")).toBe(false);
  });

  it("never creates a logistics move from a base back to the same base", () => {
    const snapshot = cloneSnapshot(makeSnapshot());
    snapshot.wishlists = [{ id: 101, title: "Forge Prime", mats: [{ id: 1, qty: 500 }] }];
    snapshot.warehouses[0].mats = [{ id: 1, qty: 20 }];

    const sameBaseOnly = analyzeSnapshot(snapshot, context);
    expect(sameBaseOnly.logisticsMoves).toHaveLength(0);

    snapshot.warehouses[1].mats = [{ id: 1, qty: 100 }];
    const withExchangeSource = analyzeSnapshot(snapshot, context);
    expect(withExchangeSource.logisticsMoves.length).toBeGreaterThan(0);
    expect(withExchangeSource.logisticsMoves.every((move) => move.from !== move.to)).toBe(true);
  });

  it("uses cash-risk preference to gate speculative recipe-input buys", () => {
    const snapshot = cloneSnapshot(makeSnapshot());
    snapshot.bases[0].productionOrders = [];
    snapshot.wishlists = [];

    const conservative = analyzeSnapshot(snapshot, { ...context, cashRiskLevel: "conservative" });
    const aggressive = analyzeSnapshot(snapshot, { ...context, cashRiskLevel: "aggressive" });

    expect(conservative.actionPlans.some((plan) => plan.title === "Buy Iron Ore")).toBe(false);
    expect(aggressive.actionPlans.some((plan) => plan.title === "Buy Iron Ore")).toBe(true);
  });

  it("lowers confidence when a spread looks attractive but volatility is high", () => {
    const snapshot = cloneSnapshot(makeSnapshot());
    snapshot.bases[0].productionOrders = [];
    snapshot.wishlists = [];
    snapshot.market.details[0].priceHistory = [
      { avgPrice: 4000, qtySold: 900 },
      { avgPrice: 9000, qtySold: 100 },
      { avgPrice: 1200, qtySold: 700 },
      { avgPrice: 8000, qtySold: 200 }
    ];

    const result = analyzeSnapshot(snapshot, { ...context, cashRiskLevel: "aggressive" });
    const signal = result.marketSignals.find((item) => item.matName === "Iron Ore");
    const plan = result.actionPlans.find((item) => item.title === "Buy Iron Ore");

    expect(signal?.trendConfidence).toBeLessThan(60);
    expect(plan?.confidence).not.toBe("high");
  });

  it("surfaces warehouse pressure as expansion only when utilization is relevant", () => {
    const result = analyzeSnapshot(makeSnapshot(), context);

    expect(result.expansionCandidates.some((candidate) => candidate.title.includes("Exchange warehouse"))).toBe(true);
  });
});

function cloneSnapshot(snapshot: GameSnapshot): GameSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as GameSnapshot;
}
