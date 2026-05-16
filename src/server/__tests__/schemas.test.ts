import { describe, expect, it } from "vitest";
import { playerPlanningContextSchema } from "../../shared/schemas.js";

describe("shared schemas", () => {
  it("accepts an optional player prompt in planning context", () => {
    const parsed = playerPlanningContextSchema.safeParse({
      autonomyHours: 12,
      cashRiskLevel: "balanced",
      shortTermGoal: "Keep production running",
      userPrompt: "What should I do before my next login?"
    });

    expect(parsed.success).toBe(true);
  });
});
