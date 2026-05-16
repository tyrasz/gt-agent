import { afterEach, describe, expect, it } from "vitest";
import { buildDeterministicSitrep } from "../analysis.js";
import { RestLlmPlanner } from "../llm/providers.js";
import { makeProviderJson, makeSnapshot } from "./fixtures.js";

const context = {
  autonomyHours: 12,
  cashRiskLevel: "balanced" as const,
  shortTermGoal: "Keep production running"
};

describe("RestLlmPlanner", () => {
  afterEach(() => {
    delete process.env.OPENAI_TIMEOUT_MS;
    delete process.env.ANTHROPIC_TIMEOUT_MS;
    delete process.env.GEMINI_TIMEOUT_MS;
    delete process.env.LLM_TIMEOUT_MS;
  });

  it("retries once when provider JSON fails schema validation", async () => {
    let calls = 0;
    const planner = new RestLlmPlanner({
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          return Response.json({ output_text: JSON.stringify({ actionPlans: [], warnings: [] }) });
        }
        return Response.json({ output_text: JSON.stringify(makeProviderJson()) });
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
    expect(result.marketSignals).toEqual(deterministicSitrep.marketSignals);
  });

  it("uses the OpenAI-specific timeout when OpenAI times out", async () => {
    process.env.OPENAI_TIMEOUT_MS = "5";
    const planner = new RestLlmPlanner({
      fetchImpl: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        })
    });

    const snapshot = makeSnapshot();
    const deterministicSitrep = buildDeterministicSitrep(snapshot, context, "openai", "test-model");

    await expect(planner.generateStructuredPlan({
      provider: "openai",
      model: "test-model",
      providerApiKey: "sk-test",
      planningContext: context,
      snapshot,
      deterministicSitrep
    })).rejects.toThrow("OpenAI did not respond within 5ms");
  });

  it("sends the player prompt inside the OpenAI planning request", async () => {
    let promptBody = "";
    let requestUrl = "";
    let requestBody: any;
    const planner = new RestLlmPlanner({
      fetchImpl: async (input, init) => {
        requestUrl = String(input);
        requestBody = JSON.parse(String(init?.body ?? "{}"));
        promptBody = requestBody.input;
        return Response.json({ output_text: JSON.stringify(makeProviderJson()) });
      }
    });

    const snapshot = makeSnapshot();
    const planningContext = {
      ...context,
      userPrompt: "Focus on cargo bottlenecks before my next login."
    };
    const deterministicSitrep = buildDeterministicSitrep(snapshot, planningContext, "openai", "test-model");

    await planner.generateStructuredPlan({
      provider: "openai",
      model: "test-model",
      providerApiKey: "sk-test",
      planningContext,
      snapshot,
      deterministicSitrep
    });

    expect(requestUrl).toBe("https://api.openai.com/v1/responses");
    expect(requestBody.text.format.type).toBe("json_schema");
    expect(requestBody.text.format.name).toBe("gt_agent_plan_draft");
    expect(requestBody.store).toBe(false);
    expect(promptBody).toContain("The player request to answer first");
    expect(promptBody).toContain("Focus on cargo bottlenecks before my next login.");
    const compactPayload = JSON.parse(promptBody.slice(promptBody.indexOf("{\"planningContext\"")));
    expect(compactPayload.deterministicSitrep.topActionPlans.length).toBeGreaterThan(0);
    expect(compactPayload.deterministicSitrep.topMarketSignals.length).toBeGreaterThan(0);
    expect(compactPayload.rawSnapshot).toBeUndefined();
    expect(JSON.stringify(compactPayload)).not.toContain("priceHistory");
  });

  it("parses nested OpenAI Responses output text", async () => {
    const planner = new RestLlmPlanner({
      fetchImpl: async () => Response.json({
        output: [
          {
            type: "message",
            content: [
              { type: "output_text", text: JSON.stringify({ summary: "Nested response worked.", actionPlans: [], warnings: [] }) }
            ]
          }
        ]
      })
    });

    const snapshot = makeSnapshot();
    const deterministicSitrep = buildDeterministicSitrep(snapshot, context, "openai", "gpt-5.5");

    const result = await planner.generateStructuredPlan({
      provider: "openai",
      model: "gpt-5.5",
      providerApiKey: "sk-test",
      planningContext: context,
      snapshot,
      deterministicSitrep
    });

    expect(result.summary).toBe("Nested response worked.");
    expect(result.actionPlans).toEqual(deterministicSitrep.actionPlans);
  });

  it("sends a Gemini response JSON schema and ignores malformed extra dashboard fields", async () => {
    let requestBody: any;
    const planner = new RestLlmPlanner({
      fetchImpl: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body ?? "{}"));
        return Response.json({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      summary: "Gemini draft worked.",
                      actionPlans: [],
                      warnings: [],
                      marketSignals: [{ matId: 1 }],
                      expansionCandidates: [{ title: "Malformed expansion" }]
                    })
                  }
                ]
              }
            }
          ]
        });
      }
    });

    const snapshot = makeSnapshot();
    const deterministicSitrep = buildDeterministicSitrep(snapshot, context, "gemini", "gemini-2.5-flash");

    const result = await planner.generateStructuredPlan({
      provider: "gemini",
      model: "gemini-2.5-flash",
      providerApiKey: "gk-test",
      planningContext: context,
      snapshot,
      deterministicSitrep
    });

    expect(requestBody.generationConfig.responseMimeType).toBe("application/json");
    expect(requestBody.generationConfig.responseJsonSchema.properties.summary.type).toBe("string");
    expect(result.summary).toBe("Gemini draft worked.");
    expect(result.marketSignals).toEqual(deterministicSitrep.marketSignals);
    expect(result.expansionCandidates).toEqual(deterministicSitrep.expansionCandidates);
  });
});
