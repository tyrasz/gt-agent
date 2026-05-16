import { describe, expect, it } from "vitest";
import { ModelCatalogService } from "../modelCatalog.js";
import { MissingProviderKeyError, type AgentSession } from "../sessionStore.js";

const session: AgentSession = {
  id: "session-1",
  gtApiKey: "gt-test-key",
  providerKeys: {
    openai: "sk-test",
    anthropic: "ak-test",
    gemini: "gk-test"
  },
  createdAt: Date.now(),
  updatedAt: Date.now()
};

describe("ModelCatalogService", () => {
  it("filters OpenAI models and chooses the preferred default", async () => {
    const service = new ModelCatalogService({
      fetchImpl: async (_input, init) => {
        expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
        return Response.json({
          data: [
            { id: "text-embedding-3-large" },
            { id: "gpt-5.4-mini" },
            { id: "gpt-5.5" },
            { id: "gpt-image-1" }
          ]
        });
      }
    });

    const catalog = await service.listModels(session, "openai", true);

    expect(catalog.defaultModel).toBe("gpt-5.5");
    expect(catalog.models.map((model) => model.id)).toEqual(["gpt-5.5", "gpt-5.4-mini"]);
    expect(catalog.warnings).toEqual([]);
  });

  it("filters Anthropic models and keeps Claude text models", async () => {
    const service = new ModelCatalogService({
      fetchImpl: async (_input, init) => {
        expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("ak-test");
        return Response.json({
          data: [
            { id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5" },
            { id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" }
          ]
        });
      }
    });

    const catalog = await service.listModels(session, "anthropic", true);

    expect(catalog.defaultModel).toBe("claude-sonnet-4-6");
    expect(catalog.models.map((model) => model.id)).toEqual(["claude-sonnet-4-6", "claude-haiku-4-5"]);
  });

  it("normalizes Gemini models that support generateContent", async () => {
    const service = new ModelCatalogService({
      fetchImpl: async (input) => {
        expect(String(input)).toContain("key=gk-test");
        return Response.json({
          models: [
            { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
            { name: "models/gemini-embedding", supportedGenerationMethods: ["embedContent"] },
            { name: "models/gemini-3.1-pro-preview", supportedActions: ["generateContent"] }
          ]
        });
      }
    });

    const catalog = await service.listModels(session, "gemini", true);

    expect(catalog.defaultModel).toBe("gemini-3.1-pro-preview");
    expect(catalog.models.map((model) => model.id)).toEqual(["gemini-3.1-pro-preview", "gemini-2.5-flash"]);
  });

  it("falls back to curated models when provider listing times out", async () => {
    const service = new ModelCatalogService({
      timeoutMs: 5,
      fetchImpl: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        })
    });

    const catalog = await service.listModels(session, "openai", true);

    expect(catalog.defaultModel).toBe("gpt-5.5");
    expect(catalog.models[0].source).toBe("fallback");
    expect(catalog.warnings[0]).toContain("timed out");
  });

  it("does not echo Gemini API keys in model-list fallback warnings", async () => {
    const service = new ModelCatalogService({
      fetchImpl: async () => {
        throw new Error("https://generativelanguage.googleapis.com/v1beta/models?key=gk-test");
      }
    });

    const catalog = await service.listModels(session, "gemini", true);

    expect(catalog.defaultModel).toBe("gemini-3.1-pro-preview");
    expect(catalog.warnings.join(" ")).not.toContain("gk-test");
    expect(catalog.warnings.join(" ")).toContain("Gemini model list request failed");
  });

  it("requires the selected provider key to be present in the session", async () => {
    const service = new ModelCatalogService();
    const openAiOnlySession: AgentSession = {
      ...session,
      providerKeys: { openai: "sk-test" }
    };

    await expect(service.listModels(openAiOnlySession, "anthropic", true)).rejects.toBeInstanceOf(MissingProviderKeyError);
  });

  it("caches model lists per session and provider", async () => {
    let calls = 0;
    const service = new ModelCatalogService({
      fetchImpl: async () => {
        calls += 1;
        return Response.json({ data: [{ id: "gpt-5.5" }] });
      }
    });

    await service.listModels(session, "openai");
    await service.listModels(session, "openai");
    await service.listModels(session, "openai", true);

    expect(calls).toBe(2);
  });
});
