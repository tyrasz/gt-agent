import { describe, expect, it } from "vitest";
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
    expect(result.actionPlans[0]?.preparedCommands.every((command) => command.executable === false)).toBe(true);
  });

  it("builds a complete deterministic sitrep with a raw snapshot", () => {
    const sitrep = buildDeterministicSitrep(makeSnapshot(), context, "openai", "test-model");

    expect(sitrep.provider).toBe("openai");
    expect(sitrep.model).toBe("test-model");
    expect(sitrep.rawSnapshot?.company.name).toBe("Stellar Foundry");
    expect(sitrep.actionPlans.length).toBeGreaterThan(0);
  });
});
