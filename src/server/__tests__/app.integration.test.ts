import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildDeterministicSitrep } from "../analysis.js";
import { createApp } from "../index.js";
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
    app = await createApp({
      sessionStore: new SessionStore(),
      gtClient: {
        getSnapshot: async () => snapshot
      } as any,
      llmPlanner: {
        generateStructuredPlan: async (input: any) => buildDeterministicSitrep(snapshot, input.planningContext, input.provider, input.model)
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
        planningContext: context
      }
    });

    expect(sitrep.statusCode).toBe(200);
    expect(sitrep.json().rawSnapshot.company.name).toBe("Stellar Foundry");
  });
});
