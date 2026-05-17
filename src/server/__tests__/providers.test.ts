import { afterEach, describe, expect, it } from "vitest";
import { buildDeterministicSitrep } from "../analysis.js";
import { isLargeModel, resolveProviderTimeoutMs, RestLlmPlanner } from "../llm/providers.js";
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
    delete process.env.OPENAI_LARGE_MODEL_TIMEOUT_MS;
    delete process.env.ANTHROPIC_LARGE_MODEL_TIMEOUT_MS;
    delete process.env.GEMINI_LARGE_MODEL_TIMEOUT_MS;
    delete process.env.LLM_LARGE_MODEL_TIMEOUT_MS;
  });

  it("resolves large and fast model timeout tiers", () => {
    const fastTimeouts = { openai: 60_000, anthropic: 30_000, gemini: 30_000 };
    const largeTimeouts = { openai: 720_000, anthropic: 720_000, gemini: 720_000 };

    expect(isLargeModel("openai", "gpt-5.5")).toBe(true);
    expect(isLargeModel("openai", "gpt-5.5-pro")).toBe(true);
    expect(isLargeModel("openai", "gpt-5.4")).toBe(true);
    expect(isLargeModel("anthropic", "claude-opus-4-7")).toBe(true);
    expect(isLargeModel("anthropic", "claude-sonnet-4-6")).toBe(true);
    expect(isLargeModel("gemini", "gemini-2.5-pro")).toBe(true);
    expect(isLargeModel("openai", "gpt-5.5-mini")).toBe(false);
    expect(isLargeModel("openai", "gpt-4.1-mini")).toBe(false);
    expect(isLargeModel("gemini", "gemini-2.5-flash")).toBe(false);
    expect(isLargeModel("anthropic", "claude-haiku-4-5")).toBe(false);

    expect(resolveProviderTimeoutMs("openai", "gpt-5.5", fastTimeouts, largeTimeouts)).toBe(720_000);
    expect(resolveProviderTimeoutMs("openai", "gpt-5.5-mini", fastTimeouts, largeTimeouts)).toBe(60_000);
  });

  it("retries once when provider JSON fails schema validation", async () => {
    let calls = 0;
    const planner = new RestLlmPlanner({
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          return Response.json({ output_text: JSON.stringify({ actionPlanNarratives: [], warnings: [] }) });
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
      model: "gpt-5.5-mini",
      providerApiKey: "sk-test",
      planningContext: context,
      snapshot,
      deterministicSitrep
    })).rejects.toThrow("OpenAI did not respond within 5ms");
  });

  it("uses the OpenAI-specific large timeout for large OpenAI models", async () => {
    process.env.OPENAI_TIMEOUT_MS = "1000";
    process.env.OPENAI_LARGE_MODEL_TIMEOUT_MS = "5";
    const planner = new RestLlmPlanner({
      fetchImpl: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        })
    });

    const snapshot = makeSnapshot();
    const deterministicSitrep = buildDeterministicSitrep(snapshot, context, "openai", "gpt-5.5");

    await expect(planner.generateStructuredPlan({
      provider: "openai",
      model: "gpt-5.5",
      providerApiKey: "sk-test",
      planningContext: context,
      snapshot,
      deterministicSitrep
    })).rejects.toThrow("OpenAI did not respond within 5ms. Try a faster model or another provider.");
  });

  it("lets provider-specific large timeout env vars override the global large timeout", async () => {
    process.env.LLM_LARGE_MODEL_TIMEOUT_MS = "1000";
    process.env.GEMINI_LARGE_MODEL_TIMEOUT_MS = "5";
    const planner = new RestLlmPlanner({
      fetchImpl: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        })
    });

    const snapshot = makeSnapshot();
    const deterministicSitrep = buildDeterministicSitrep(snapshot, context, "gemini", "gemini-2.5-pro");

    await expect(planner.generateStructuredPlan({
      provider: "gemini",
      model: "gemini-2.5-pro",
      providerApiKey: "gk-test",
      planningContext: context,
      snapshot,
      deterministicSitrep
    })).rejects.toThrow("Gemini did not respond within 5ms. Try a faster model or another provider.");
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
    expect(promptBody).toContain("Money values from GT raw fields are integer cents.");
    const compactPayload = JSON.parse(promptBody.slice(promptBody.indexOf("{\"planningContext\"")));
    expect(compactPayload.snapshotSummary.company.cashCents).toBe(5_000_000);
    expect(compactPayload.snapshotSummary.company.cashDisplay).toBe("$50,000");
    expect(compactPayload.snapshotSummary.company.cash).toBeUndefined();
    expect(compactPayload.deterministicSitrep.situation.cash.currentCents).toBe(5_000_000);
    expect(compactPayload.deterministicSitrep.situation.cash.currentDisplay).toBe("$50,000");
    expect(compactPayload.deterministicSitrep.situation.cash.current).toBeUndefined();
    expect(compactPayload.deterministicSitrep.projections.horizons.map((horizon: { hours: number }) => horizon.hours)).toEqual([12, 24, 72, 168]);
    expect(compactPayload.deterministicSitrep.projections.bands.length).toBeGreaterThan(0);
    expect(compactPayload.deterministicSitrep.profitability.companyFit.length).toBeGreaterThan(0);
    expect(compactPayload.deterministicSitrep.profitability.globalTargets.length).toBeGreaterThan(0);
    expect(compactPayload.deterministicSitrep.profitability.companyFit[0].profitPerHourDisplay).toContain("/h");
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
              { type: "output_text", text: JSON.stringify({ summary: "Nested response worked.", decisionBriefNarrative: {}, actionPlanNarratives: [], warnings: [] }) }
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
                      decisionBriefNarrative: {},
                      actionPlanNarratives: [],
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
    expect(requestBody.generationConfig.responseSchema.properties.summary.type).toBe("string");
    expect(result.summary).toBe("Gemini draft worked.");
    expect(result.marketSignals).toEqual(deterministicSitrep.marketSignals);
    expect(result.expansionCandidates).toEqual(deterministicSitrep.expansionCandidates);
  });

  it("merges only narratives for existing deterministic action ids", async () => {
    const snapshot = makeSnapshot();
    const deterministicSitrep = buildDeterministicSitrep(snapshot, context, "openai", "test-model");
    const firstPlan = deterministicSitrep.actionPlans[0];
    const secondPlan = deterministicSitrep.actionPlans[1];
    expect(firstPlan).toBeDefined();

    const planner = new RestLlmPlanner({
      fetchImpl: async () => Response.json({
        output_text: JSON.stringify(makeProviderJson({
          summary: "Narrative summary.",
          decisionBriefNarrative: {
            thesis: "Narrative thesis.",
            alternatives: [
              {
                title: deterministicSitrep.decisionBrief.alternatives[0]?.title,
                pros: ["Narrative pro."],
                cons: ["Narrative con."],
                chooseWhen: "Narrative choose-when."
              },
              {
                title: "Invented alternative",
                chooseWhen: "This should be ignored."
              }
            ]
          },
          actionPlanNarratives: [
            {
              id: firstPlan!.id,
              expectedBenefit: "Narrative benefit grounded in the scored plan.",
              risk: "Narrative risk.",
              whyNow: "Narrative why-now.",
              bestWhen: "Narrative best-when.",
              avoidIf: "Narrative avoid-if.",
              whatWouldChangeThis: "Narrative change trigger.",
              evidence: ["Narrative evidence."]
            },
            {
              id: "invented-action",
              expectedBenefit: "This should be ignored."
            }
          ]
        }))
      })
    });

    const result = await planner.generateStructuredPlan({
      provider: "openai",
      model: "test-model",
      providerApiKey: "sk-test",
      planningContext: context,
      snapshot,
      deterministicSitrep
    });

    expect(result.actionPlans.map((plan) => plan.id)).toEqual(deterministicSitrep.actionPlans.map((plan) => plan.id));
    expect(result.actionPlans[0]).toMatchObject({
      id: firstPlan!.id,
      expectedBenefit: "Narrative benefit grounded in the scored plan.",
      risk: "Narrative risk.",
      whyNow: "Narrative why-now.",
      bestWhen: "Narrative best-when.",
      avoidIf: "Narrative avoid-if.",
      whatWouldChangeThis: "Narrative change trigger.",
      score: firstPlan!.score,
      scoreBreakdown: firstPlan!.scoreBreakdown
    });
    expect(result.actionPlans[0]?.evidence).toContain("Narrative evidence.");
    if (secondPlan) expect(result.actionPlans[1]).toEqual(secondPlan);
    expect(result.actionPlans.some((plan) => plan.id === "invented-action")).toBe(false);
    expect(result.decisionBrief.thesis).toBe("Narrative thesis.");
    expect(result.decisionBrief.confidence).toBe(deterministicSitrep.decisionBrief.confidence);
    expect(result.decisionBrief.alternatives.some((alternative) => alternative.title === "Invented alternative")).toBe(false);
    expect(result.decisionBrief.alternatives[0]?.pros).toEqual(["Narrative pro."]);
    expect(result.projections).toEqual(deterministicSitrep.projections);
  });
});
