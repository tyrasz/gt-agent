import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildDeterministicSitrep } from "../analysis.js";
import { createApp } from "../index.js";
import { RestLlmPlanner } from "../llm/providers.js";
import { SessionStore } from "../sessionStore.js";
import { makeSnapshot } from "./fixtures.js";

const context = {
  autonomyHours: 12,
  cashRiskLevel: "balanced" as const,
  shortTermGoal: "Keep production running"
};

describe("API integration", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it("stores keys only behind an HTTP-only session cookie and returns a sitrep", async () => {
    const snapshot = makeSnapshot();
    let observedRefresh: unknown;
    let observedPlanningContext: unknown;
    app = await createApp({
      sessionStore: new SessionStore(),
      gtClient: {
        getSnapshot: async (_session: unknown, refresh: unknown) => {
          observedRefresh = refresh;
          return snapshot;
        }
      } as any,
      llmPlanner: {
        generateStructuredPlan: async (input: any) => {
          observedPlanningContext = input.planningContext;
          return buildDeterministicSitrep(snapshot, input.planningContext, input.provider, input.model);
        }
      } as any
    });

    const keys = await app.inject({
      method: "POST",
      url: "/api/session/keys",
      payload: {
        gtApiKey: "gt-secret-key",
        providerKeys: { openai: "sk-secret-key" }
      }
    });

    expect(keys.statusCode).toBe(200);
    expect(keys.body).not.toContain("gt-secret-key");
    expect(keys.headers["set-cookie"]).toContain("HttpOnly");

    const sitrep = await app.inject({
      method: "POST",
      url: "/api/agent/sitrep",
      headers: { cookie: String(keys.headers["set-cookie"]) },
      payload: {
        provider: "openai",
        model: "test-model",
        planningContext: {
          ...context,
          userPrompt: "Find the best restock move."
        }
      }
    });

    expect(sitrep.statusCode).toBe(200);
    expect(sitrep.json().rawSnapshot.company.name).toBe("Stellar Foundry");
    expect(observedRefresh).toEqual({ forceCompany: true, forceMarket: true, forceGameData: false });
    expect(observedPlanningContext).toMatchObject({ userPrompt: "Find the best restock move." });
  });

  it("returns session provider models without exposing keys", async () => {
    app = await createApp({
      sessionStore: new SessionStore(),
      modelCatalog: {
        listModels: async () => ({
          provider: "openai",
          defaultModel: "gpt-5.5",
          models: [{ id: "gpt-5.5", label: "gpt-5.5", source: "provider" }],
          warnings: []
        })
      } as any
    });

    const missingSession = await app.inject({
      method: "GET",
      url: "/api/session/models?provider=openai"
    });
    expect(missingSession.statusCode).toBe(401);

    const keys = await app.inject({
      method: "POST",
      url: "/api/session/keys",
      payload: {
        gtApiKey: "gt-secret-key",
        providerKeys: { openai: "sk-secret-key" }
      }
    });

    const models = await app.inject({
      method: "GET",
      url: "/api/session/models?provider=openai&refresh=true",
      headers: { cookie: String(keys.headers["set-cookie"]) }
    });

    expect(models.statusCode).toBe(200);
    expect(models.body).toContain("gpt-5.5");
    expect(models.body).not.toContain("sk-secret-key");
  });

  it("rejects model listing for providers without a stored key", async () => {
    app = await createApp({ sessionStore: new SessionStore() });

    const keys = await app.inject({
      method: "POST",
      url: "/api/session/keys",
      payload: {
        gtApiKey: "gt-secret-key",
        providerKeys: { openai: "sk-secret-key" }
      }
    });

    const models = await app.inject({
      method: "GET",
      url: "/api/session/models?provider=anthropic",
      headers: { cookie: String(keys.headers["set-cookie"]) }
    });

    expect(models.statusCode).toBe(400);
    expect(models.body).toContain("No anthropic API key");
    expect(models.body).not.toContain("sk-secret-key");
  });

  it("merges an LLM draft with deterministic dashboard data", async () => {
    const snapshot = makeSnapshot();
    app = await createApp({
      sessionStore: new SessionStore(),
      gtClient: {
        getSnapshot: async () => snapshot
      } as any,
      llmPlanner: new RestLlmPlanner({
        fetchImpl: async () => Response.json({
          output_text: JSON.stringify({
            summary: "LLM summary focused on restocking.",
            actionPlans: [],
            warnings: ["Provider caveat."]
          })
        })
      })
    });

    const keys = await app.inject({
      method: "POST",
      url: "/api/session/keys",
      payload: {
        gtApiKey: "gt-secret-key",
        providerKeys: { openai: "sk-secret-key" }
      }
    });

    const sitrep = await app.inject({
      method: "POST",
      url: "/api/agent/sitrep",
      headers: { cookie: String(keys.headers["set-cookie"]) },
      payload: {
        provider: "openai",
        model: "gpt-5.5",
        planningContext: context
      }
    });

    const body = sitrep.json();
    const deterministic = buildDeterministicSitrep(snapshot, context, "openai", "gpt-5.5");
    expect(sitrep.statusCode).toBe(200);
    expect(body.diagnostics.source).toBe("llm");
    expect(body.summary).toBe("LLM summary focused on restocking.");
    expect(body.actionPlans).toHaveLength(deterministic.actionPlans.length);
    expect(body.marketSignals).toHaveLength(deterministic.marketSignals.length);
    expect(body.expansionCandidates).toHaveLength(deterministic.expansionCandidates.length);
    expect(body.warnings).toContain("Provider caveat.");
  });

  it("returns deterministic output when provider draft validation fails", async () => {
    const snapshot = makeSnapshot();
    app = await createApp({
      sessionStore: new SessionStore(),
      gtClient: {
        getSnapshot: async () => snapshot
      } as any,
      llmPlanner: new RestLlmPlanner({
        fetchImpl: async () => Response.json({ output_text: JSON.stringify({ actionPlans: [], warnings: [] }) })
      })
    });

    const keys = await app.inject({
      method: "POST",
      url: "/api/session/keys",
      payload: {
        gtApiKey: "gt-secret-key",
        providerKeys: { openai: "sk-secret-key" }
      }
    });

    const sitrep = await app.inject({
      method: "POST",
      url: "/api/agent/sitrep",
      headers: { cookie: String(keys.headers["set-cookie"]) },
      payload: {
        provider: "openai",
        model: "gpt-5.5",
        planningContext: context
      }
    });

    const body = sitrep.json();
    expect(sitrep.statusCode).toBe(200);
    expect(body.diagnostics.source).toBe("deterministic");
    expect(body.warnings.join(" ")).toContain("LLM provider unavailable or invalid");
    expect(body.marketSignals.length).toBeGreaterThan(0);
  });

  it("returns deterministic output with an actionable OpenAI timeout warning", async () => {
    const snapshot = makeSnapshot();
    app = await createApp({
      sessionStore: new SessionStore(),
      gtClient: {
        getSnapshot: async () => snapshot
      } as any,
      llmPlanner: new RestLlmPlanner({
        timeoutMsByProvider: { openai: 5 },
        fetchImpl: async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            });
          })
      })
    });

    const keys = await app.inject({
      method: "POST",
      url: "/api/session/keys",
      payload: {
        gtApiKey: "gt-secret-key",
        providerKeys: { openai: "sk-secret-key" }
      }
    });

    const sitrep = await app.inject({
      method: "POST",
      url: "/api/agent/sitrep",
      headers: { cookie: String(keys.headers["set-cookie"]) },
      payload: {
        provider: "openai",
        model: "gpt-5.5",
        planningContext: context
      }
    });

    const body = sitrep.json();
    expect(sitrep.statusCode).toBe(200);
    expect(body.diagnostics.source).toBe("deterministic");
    expect(body.warnings.join(" ")).toContain("OpenAI did not respond within 5ms; showing deterministic sitrep. Try a faster model or increase timeout.");
    expect(body.warnings.join(" ")).not.toContain("LLM provider unavailable or invalid");
  });
});
