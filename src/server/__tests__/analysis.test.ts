import { describe, expect, it } from "vitest";
import type { GameSnapshot } from "../../shared/schemas.js";
import { analyzeSnapshot, buildDeterministicSitrep } from "../analysis.js";
import { makeSnapshot } from "./fixtures.js";

const context = {
  autonomyHours: 12,
  cashRiskLevel: "balanced" as const,
  shortTermGoal: "Keep production running"
};

describe("analysis", () => {
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
    expect(sitrep.marketSignals[0]).toHaveProperty("liquidityScore");
  });

  it("does not rank a cheap material buy when the company has no demand or recipe use", () => {
    const snapshot = cloneSnapshot(makeSnapshot());
    snapshot.gameData.materials = [
      ...(snapshot.gameData.materials as Record<string, unknown>[]),
      { id: 3, name: "Copper Dust", weight: 1, cp: 300 }
    ];
    snapshot.market.prices.push({ matId: 3, matName: "Copper Dust", currentPrice: 100, avgPrice: 500 });
    snapshot.market.details.push({
      matId: 3,
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
