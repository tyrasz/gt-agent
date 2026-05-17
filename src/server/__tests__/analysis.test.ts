import { describe, expect, it } from "vitest";
import type { GameSnapshot } from "../../shared/schemas.js";
import { analyzeSnapshot, buildDeterministicSitrep } from "../analysis.js";
import { normalizeSnapshot } from "../analysis/normalizers.js";
import { computeProfitability } from "../analysis/profitability.js";
import { classifyPlanningIntent } from "../analysis/strategy.js";
import { StrategyHistoryStore } from "../historyStore.js";
import { evaluateWhatIf } from "../whatIf.js";
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

  it("ranks fulfillable contract decisions above blocked contract work", () => {
    const snapshot = cloneSnapshot(makeSnapshot());
    snapshot.contracts = [
      {
        id: "ore-rush",
        title: "Iron Ore Rush",
        reward: 1_000_000,
        materials: [{ id: 1, qty: 10 }],
        deadline: "2030-01-01T00:00:00.000Z",
        status: "active"
      },
      {
        id: "bar-sink",
        title: "Iron Bar Sink",
        payout: 1_000,
        requirements: [{ id: 2, qty: 5_000 }],
        status: "active"
      }
    ];

    const sitrep = buildDeterministicSitrep(snapshot, context, "openai", "test-model");
    const top = sitrep.decisionPanel.actions[0];
    const blocked = sitrep.decisionPanel.actions.find((action) => action.id === "contract-bar-sink");

    expect(top).toMatchObject({
      kind: "contract",
      action: "fulfill_contract",
      title: "Fulfill Iron Ore Rush",
      expectedValue: 1_000_000
    });
    expect(blocked?.action).toBe("skip_contract");
    expect(blocked?.blockers.join(" ")).toContain("Visible payout does not cover");
    expect(sitrep.decisionPanel.actions.every((action) => action.preparedCommands.every((command) => command.executable === false))).toBe(true);
  });

  it("keeps incomplete contract payloads as low-confidence review decisions", () => {
    const snapshot = cloneSnapshot(makeSnapshot());
    snapshot.contracts = [{ id: "mystery", title: "Mystery Contract", status: "active" }];

    const sitrep = buildDeterministicSitrep(snapshot, context, "openai", "test-model");
    const contract = sitrep.decisionPanel.actions.find((action) => action.id === "contract-mystery");

    expect(contract?.action).toBe("review_contract");
    expect(contract?.confidence).toBe("low");
    expect(contract?.blockers.join(" ")).toContain("material requirements");
    expect(contract?.blockers.join(" ")).toContain("cash payout");
  });

  it("uses visible market shortage cost and cash-risk gates for contract staging", () => {
    const snapshot = cloneSnapshot(makeSnapshot());
    snapshot.contracts = [
      {
        id: "huge-ore",
        title: "Huge Ore Contract",
        reward: 100_000_000,
        materials: [{ id: 1, qty: 10_000 }],
        status: "active"
      }
    ];

    const sitrep = buildDeterministicSitrep(snapshot, context, "openai", "test-model");
    const contract = sitrep.decisionPanel.actions.find((action) => action.id === "contract-huge-ore");

    expect(contract?.action).toBe("prepare_contract");
    expect(contract?.requirements[0]?.estimatedCost).toBe(39_920_000);
    expect(contract?.cashImpactPct ?? 0).toBeGreaterThan(25);
    expect(contract?.blockers.join(" ")).toContain("cash-risk gate");
  });

  it("promotes actionable exchange buys and reprices without promoting watch-only materials", () => {
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

    const sitrep = buildDeterministicSitrep(snapshot, context, "openai", "test-model");
    const exchangeActions = sitrep.decisionPanel.actions.filter((action) => action.kind === "exchange");

    expect(exchangeActions.some((action) => action.action === "buy_material" && action.title === "Buy Iron Ore")).toBe(true);
    expect(exchangeActions.some((action) => action.action === "adjust_sell_offer" && action.title === "Reprice Iron Bar")).toBe(true);
    expect(exchangeActions.some((action) => action.title.includes("Copper Dust"))).toBe(false);
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
    expect(sitrep.decisionPanel.actions.length).toBeGreaterThan(0);
    expect(sitrep.projections.horizons.map((horizon) => horizon.hours)).toEqual([12, 24, 72, 168]);
    expect(sitrep.marketSignals[0]).toHaveProperty("liquidityScore");
    expect(sitrep.profitability?.companyFit.length).toBeGreaterThan(0);
    expect(sitrep.profitability?.globalTargets.length).toBeGreaterThan(0);
    expect(sitrep.profitability?.chains.length).toBeGreaterThan(0);
    expect(sitrep.chainOpportunities?.length).toBeGreaterThan(0);
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

  it("keeps hard-blocked targets out of main action ranking", () => {
    const sitrep = buildDeterministicSitrep({
      ...makeSnapshot(),
      wishlists: []
    }, { ...context, userPrompt: "How do I increase CV through profit?" }, "openai", "test-model");

    expect(sitrep.profitability?.companyFit[0]?.title).toContain("Iron Bar");
    expect(sitrep.profitability?.blockedTargets[0]?.title).toContain("Tools");
    expect(sitrep.profitability?.blockedTargets[0]?.techRequirement).toContain("research level 4");
    const companyPlanIndex = sitrep.actionPlans.findIndex((plan) => plan.title.includes("Iron Bar") && plan.category === "profitability");
    const blockedPlanIndex = sitrep.actionPlans.findIndex((plan) => plan.title.includes("Tools") && plan.category === "profitability");
    expect(companyPlanIndex).toBeGreaterThanOrEqual(0);
    expect(blockedPlanIndex).toBe(-1);
  });

  it("ranks linked production chains and creates chain action plans when the first step is affordable", () => {
    const snapshot = cloneSnapshot(makeSnapshot());
    snapshot.company.cash = 10_000_000;
    const toolworks = (snapshot.gameData.buildings as Record<string, unknown>[]).find((building) => building.id === 20);
    if (toolworks) toolworks.requiredResearch = 0;
    const sitrep = buildDeterministicSitrep(snapshot, {
      ...context,
      userPrompt: "Increase CV by optimizing production chains."
    }, "openai", "test-model");
    const chain = sitrep.profitability?.chains.find((item) => item.title.includes("Iron Bar -> Tools"));
    const opportunity = sitrep.profitability?.chainOpportunities.find((item) => item.chainId === chain?.id);
    const plan = sitrep.actionPlans.find((item) => item.id.includes("profit-chain") && item.title.includes("Tools"));

    expect(chain).toBeTruthy();
    expect(chain?.steps.map((step) => step.outputMatName)).toEqual(["Iron Bar", "Tools"]);
    expect(chain?.capitalFit).toBe("affordable");
    expect(opportunity?.profitPerHour).toBeGreaterThan(0);
    expect(plan?.category).toBe("profitability");
    expect(plan?.profitabilityTag).toMatch(/chain/);
  });

  it("puts inaccessible ore targets in blocked long-term references for a $1.3m company", () => {
    const sitrep = buildDeterministicSitrep(makeCompanyPathSnapshot(), {
      ...context,
      userPrompt: "Give me a 3 day and 7 day path to grow CV from current capital."
    }, "openai", "test-model");
    const nextStepTitles = sitrep.profitability?.nextSteps.map((item) => item.title).join(" ") ?? "";
    const blockedTitles = sitrep.profitability?.blockedTargets.map((item) => item.title).join(" ") ?? "";
    const actionTitles = sitrep.actionPlans.map((plan) => plan.title).join(" ");
    const timelineActionIds = sitrep.projections.bands.flatMap((band) => band.actionIds).join(" ");
    const uranium = sitrep.profitability?.blockedTargets.find((item) => item.title.includes("Uranium Ore"));
    const aeridium = sitrep.profitability?.blockedTargets.find((item) => item.title.includes("Aeridium Ore"));

    expect(nextStepTitles).toContain("Bridge Widgets");
    expect(blockedTitles).toMatch(/Uranium Ore|Aeridium Ore/);
    expect(uranium?.capitalFit).toBe("blocked");
    expect(uranium?.resourceAccess).toBe("blocked");
    expect(uranium?.knownMinimumCapital).toBeGreaterThan(0);
    expect((uranium?.unpricedRequirements ?? []).join(" ")).toMatch(/planet\/base\/resource|Research path/);
    expect(aeridium?.knownCapitalGap ?? 0).toBeGreaterThan(0);
    expect(actionTitles).toContain("Bridge Widgets");
    expect(actionTitles).not.toMatch(/Uranium Ore|Aeridium Ore/);
    expect(timelineActionIds).not.toMatch(/9001|9002/);
    expect(sitrep.decisionBrief.recommendedPath.join(" ")).toContain("Bridge Widgets");
    expect(sitrep.decisionBrief.whyThisPath.join(" ")).toMatch(/excluded from action ranking/i);
  });

  it("keeps active resource extraction recipes company-fit when access is visible", () => {
    const snapshot = makeCompanyPathSnapshot();
    snapshot.bases[0].productionOrders = [{ recipeId: 9001 }];
    const sitrep = buildDeterministicSitrep(snapshot, {
      ...context,
      userPrompt: "Review current ore production profitability."
    }, "openai", "test-model");
    const uraniumRecipe = sitrep.profitability?.recipes.find((item) => item.outputMatName === "Uranium Ore");

    expect(uraniumRecipe?.companyFit).toBe("active");
    expect(uraniumRecipe?.resourceAccess).toBe("owned");
    expect(sitrep.profitability?.companyFit.some((item) => item.title.includes("Uranium Ore"))).toBe(true);
    expect(sitrep.profitability?.blockedTargets.some((item) => item.title.includes("Uranium Ore"))).toBe(false);
  });

  it("uses cash-risk gates to promote only affordable progression moves", () => {
    const snapshot = makeCompanyPathSnapshot();
    const balanced = buildDeterministicSitrep(snapshot, { ...context, cashRiskLevel: "balanced", userPrompt: "Find profit growth next steps." }, "openai", "test-model");
    const aggressive = buildDeterministicSitrep(snapshot, { ...context, cashRiskLevel: "aggressive", userPrompt: "Find profit growth next steps." }, "openai", "test-model");

    expect(balanced.profitability?.nextSteps.some((item) => item.title.includes("Quantum Frames"))).toBe(false);
    expect(balanced.profitability?.aspirationalTargets.some((item) => item.title.includes("Quantum Frames"))).toBe(true);
    expect(aggressive.profitability?.nextSteps.some((item) => item.title.includes("Quantum Frames"))).toBe(true);
    expect(aggressive.profitability?.aspirationalTargets.some((item) => item.title.includes("Quantum Frames"))).toBe(false);
  });

  it("stores only sanitized session history and detects repeated strategy signals", () => {
    const store = new StrategyHistoryStore();
    const first = buildDeterministicSitrep(makeSnapshot(), context, "openai", "test-model");
    const secondSnapshot = cloneSnapshot(makeSnapshot());
    secondSnapshot.company.cash = 5_500_000;
    secondSnapshot.company.value = 21_000_000;
    const second = buildDeterministicSitrep(secondSnapshot, context, "openai", "test-model");

    store.record("session-a", first);
    const summary = store.record("session-a", second);
    const serialized = JSON.stringify(summary);

    expect(summary.entries).toHaveLength(2);
    expect(summary.trendSignals.some((signal) => signal.kind === "cash" && signal.severity === "positive")).toBe(true);
    expect(summary.trendSignals.some((signal) => signal.kind === "profitability")).toBe(true);
    expect(serialized).not.toContain("gt-secret");
    expect(serialized).not.toContain("sk-");
    expect(serialized).not.toContain("providerKeys");
    expect(serialized).not.toContain("gtApiKey");
    expect(serialized).not.toContain("rawSnapshot");
  });

  it("evaluates what-if scenarios without mutating the source snapshot", () => {
    const snapshot = cloneSnapshot(makeSnapshot());
    const before = JSON.stringify(snapshot);
    const result = evaluateWhatIf(snapshot, {
      scenarioType: "stage_inputs",
      planningContext: context,
      recipeId: 2001
    });

    expect(result.scenario.title).toContain("Tools");
    expect(result.deltas.profitPerHour ?? 0).toBeGreaterThan(0);
    expect(result.scenario.cash).toBeLessThan(result.baseline.cash ?? Infinity);
    expect(result.preparedCommands.every((command) => command.executable === false)).toBe(true);
    expect(JSON.stringify(snapshot)).toBe(before);
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
    expect(sitrep.decisionBrief.alternatives.map((item) => item.title).join(" ")).toMatch(/blocked reference .*Tools/i);
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

  it("keeps percentage-only repricing watch-only when the absolute premium is immaterial", () => {
    const snapshot = cloneSnapshot(makeSnapshot());
    snapshot.company.cash = 158_882_622;
    snapshot.gameData.materials = [
      ...(snapshot.gameData.materials as Record<string, unknown>[]),
      { id: 30, name: "Grain", weight: 1, cp: 1200 }
    ];
    snapshot.warehouses[0].mats = [{ id: 30, qty: 5_098 }];
    snapshot.market.prices.push({ matId: 30, matName: "Grain", currentPrice: 1550, avgPrice: 1291 });
    snapshot.market.details.push({
      matId: 30,
      matName: "Grain",
      currentPrice: 1550,
      avgPrice: 1291,
      totalQtyAvailable: 8_000,
      avgQtySoldDaily: 5_000,
      priceHistory: [
        { avgPrice: 1550, qtySold: 5_000 },
        { avgPrice: 1291, qtySold: 4_000 }
      ]
    });

    const result = analyzeSnapshot(snapshot, { ...context, shortTermGoal: "Find the highest-impact actions" });
    const grain = result.marketSignals.find((signal) => signal.matName === "Grain");

    expect(grain?.spreadPct).toBe(20.06);
    expect(grain?.spreadValue).toBe(1_320_382);
    expect(grain?.materialityPct).toBe(0.83);
    expect(grain?.recommendation).toBe("watch");
    expect(result.actionPlans.some((plan) => plan.title === "Reprice Grain")).toBe(false);
    expect(result.decisionPanel.actions.some((action) => action.title === "Reprice Grain")).toBe(false);
  });

  it("still promotes repricing when the same spread has material dollar impact", () => {
    const snapshot = cloneSnapshot(makeSnapshot());
    snapshot.company.cash = 158_882_622;
    snapshot.gameData.materials = [
      ...(snapshot.gameData.materials as Record<string, unknown>[]),
      { id: 30, name: "Grain", weight: 1, cp: 1200 }
    ];
    snapshot.warehouses[0].mats = [{ id: 30, qty: 20_000 }];
    snapshot.market.prices.push({ matId: 30, matName: "Grain", currentPrice: 1550, avgPrice: 1291 });
    snapshot.market.details.push({
      matId: 30,
      matName: "Grain",
      currentPrice: 1550,
      avgPrice: 1291,
      totalQtyAvailable: 80_000,
      avgQtySoldDaily: 20_000,
      priceHistory: [
        { avgPrice: 1550, qtySold: 20_000 },
        { avgPrice: 1291, qtySold: 18_000 }
      ]
    });

    const result = analyzeSnapshot(snapshot, { ...context, shortTermGoal: "Find the highest-impact actions" });
    const grain = result.marketSignals.find((signal) => signal.matName === "Grain");

    expect(grain?.spreadValue).toBe(5_180_000);
    expect(grain?.materialityPct ?? 0).toBeGreaterThan(3);
    expect(grain?.recommendation).toBe("sell");
    expect(result.actionPlans.some((plan) => plan.title === "Reprice Grain")).toBe(true);
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

function makeCompanyPathSnapshot(): GameSnapshot {
  const snapshot = cloneSnapshot(makeSnapshot());
  snapshot.company.cash = 130_000_000;
  snapshot.wishlists = [];
  snapshot.gameData.materials = [
    ...(snapshot.gameData.materials as Record<string, unknown>[]),
    { id: 4, name: "Bridge Widgets", weight: 1, cp: 20_000 },
    { id: 5, name: "Quantum Frames", weight: 1, cp: 90_000 },
    { id: 6, name: "Uranium Ore", weight: 4, cp: 8_000_000 },
    { id: 7, name: "Aeridium Ore", weight: 4, cp: 7_000_000 }
  ];
  snapshot.market.prices.push(
    { matId: 4, matName: "Bridge Widgets", currentPrice: 30_000, avgPrice: 25_000 },
    { matId: 5, matName: "Quantum Frames", currentPrice: 300_000, avgPrice: 250_000 },
    { matId: 6, matName: "Uranium Ore", currentPrice: 12_000_000, avgPrice: 10_000_000 },
    { matId: 7, matName: "Aeridium Ore", currentPrice: 10_000_000, avgPrice: 9_000_000 }
  );
  snapshot.market.details.push(
    {
      matId: 4,
      matName: "Bridge Widgets",
      currentPrice: 30_000,
      avgPrice: 25_000,
      totalQtyAvailable: 6_000,
      avgQtySoldDaily: 900,
      priceHistory: [{ avgPrice: 30_000, qtySold: 900 }, { avgPrice: 25_000, qtySold: 700 }]
    },
    {
      matId: 5,
      matName: "Quantum Frames",
      currentPrice: 300_000,
      avgPrice: 250_000,
      totalQtyAvailable: 3_000,
      avgQtySoldDaily: 750,
      priceHistory: [{ avgPrice: 300_000, qtySold: 750 }, { avgPrice: 250_000, qtySold: 650 }]
    },
    {
      matId: 6,
      matName: "Uranium Ore",
      currentPrice: 12_000_000,
      avgPrice: 10_000_000,
      totalQtyAvailable: 2_000,
      avgQtySoldDaily: 600,
      priceHistory: [{ avgPrice: 12_000_000, qtySold: 600 }, { avgPrice: 10_000_000, qtySold: 500 }]
    },
    {
      matId: 7,
      matName: "Aeridium Ore",
      currentPrice: 10_000_000,
      avgPrice: 9_000_000,
      totalQtyAvailable: 2_000,
      avgQtySoldDaily: 600,
      priceHistory: [{ avgPrice: 10_000_000, qtySold: 600 }, { avgPrice: 9_000_000, qtySold: 500 }]
    }
  );
  snapshot.gameData.recipes = [
    ...(snapshot.gameData.recipes as Record<string, unknown>[]),
    {
      id: 3001,
      producedIn: 30,
      timeMinutes: 60,
      inputs: [{ id: 2, am: 10 }],
      output: { id: 4, am: 10 }
    },
    {
      id: 4001,
      producedIn: 40,
      timeMinutes: 60,
      inputs: [{ id: 4, am: 10 }],
      output: { id: 5, am: 10 }
    },
    {
      id: 9001,
      producedIn: 90,
      timeMinutes: 60,
      inputs: [],
      output: { id: 6, am: 1 }
    },
    {
      id: 9002,
      producedIn: 91,
      timeMinutes: 60,
      inputs: [],
      output: { id: 7, am: 1 }
    }
  ];
  snapshot.gameData.buildings = [
    ...(snapshot.gameData.buildings as Record<string, unknown>[]),
    {
      id: 30,
      name: "Bridge Workshop",
      specialization: 2,
      tier: 2,
      requiredResearch: 0,
      recipesIds: [3001],
      workersNeeded: [10, 0, 0, 0],
      constructionMaterials: [],
      cost: 10_000_000
    },
    {
      id: 40,
      name: "Quantum Assembly",
      specialization: 2,
      tier: 3,
      requiredResearch: 0,
      recipesIds: [4001],
      workersNeeded: [20, 10, 0, 0],
      constructionMaterials: [],
      cost: 50_000_000
    },
    {
      id: 90,
      name: "Uranium Mine",
      specialization: 4,
      tier: 5,
      requiredResearch: 15,
      recipesIds: [9001],
      workersNeeded: [50, 25, 5, 0],
      constructionMaterials: [],
      cost: 100_000_000
    },
    {
      id: 91,
      name: "Aeridium Extractor",
      specialization: 4,
      tier: 5,
      requiredResearch: 15,
      recipesIds: [9002],
      workersNeeded: [50, 25, 5, 0],
      constructionMaterials: [],
      cost: 140_000_000
    }
  ];
  return snapshot;
}
