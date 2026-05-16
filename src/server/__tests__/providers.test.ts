import { describe, expect, it } from "vitest";
import { buildDeterministicSitrep } from "../analysis.js";
import { RestLlmPlanner } from "../llm/providers.js";
import { makeProviderJson, makeSnapshot } from "./fixtures.js";

const context = {
  autonomyHours: 12,
  cashRiskLevel: "balanced" as const,
  shortTermGoal: "Keep production running"
};

describe("RestLlmPlanner", () => {
  it("retries once when provider JSON fails schema validation", async () => {
    let calls = 0;
    const planner = new RestLlmPlanner({
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          return Response.json({ choices: [{ message: { content: JSON.stringify({ summary: "missing fields" }) } }] });
        }
        return Response.json({ choices: [{ message: { content: JSON.stringify(makeProviderJson()) } }] });
      }
    });

    const snapshot = makeSnapshot();
    const deterministicSitrep = buildDeterministicSitrep(snapshot, context, "openai", "test-model");
    const result = await planner.generateStructuredPlan({
      provider: "openai",
      model: "test-model",
      providerApiKey: "sk-test",
      planningContext: context,
      snapshot,
      deterministicSitrep
    });

    expect(calls).toBe(2);
    expect(result.summary).toContain("Prioritize");
    expect(result.rawSnapshot?.company.name).toBe("Stellar Foundry");
  });
});
