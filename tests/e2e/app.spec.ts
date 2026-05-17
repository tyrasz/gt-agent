import { expect, test } from "@playwright/test";

test("setup and sitrep dashboard flow", async ({ page }) => {
  await page.route("**/api/session/keys", async (route) => {
    await route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/session/models?provider=openai&refresh=false", async (route) => {
    await route.fulfill({
      json: {
        provider: "openai",
        defaultModel: "gpt-5.5-mini",
        models: [
          { id: "gpt-5.5-mini", label: "gpt-5.5-mini", source: "provider" },
          { id: "gpt-5.4-mini", label: "gpt-5.4-mini", source: "provider" },
          { id: "gpt-5.5", label: "gpt-5.5", source: "provider" }
        ],
        warnings: []
      }
    });
  });
  await page.route("**/api/agent/sitrep", async (route) => {
    const payload = route.request().postDataJSON();
    expect(payload.model).toBe("gpt-5.5-mini");
    expect(payload.planningContext.userPrompt).toContain("restock");
    expect(payload.refresh).toEqual({ forceCompany: true, forceMarket: true, forceGameData: false });
    await route.fulfill({
      json: {
        generatedAt: new Date().toISOString(),
        provider: "openai",
        model: "gpt-5.5-mini",
        summary: "Restock inputs and review exchange pricing.",
        actionPlans: [
          {
            id: "restock-1",
            title: "Restock Iron Ore",
            priority: "high",
            category: "operations",
            score: 84,
            confidence: "high",
            whyNow: "Iron Ore coverage is inside the 12-hour planning window.",
            scoreBreakdown: {
              urgency: 90,
              companyFit: 100,
              profitPotential: 10,
              marketConfidence: 65,
              feasibility: 88,
              goalAlignment: 85
            },
            expectedBenefit: "Keeps production running.",
            costSummary: "100 units.",
            risk: "Price can move.",
            evidence: ["20 available vs 120 required."],
            preparedCommands: [
              {
                type: "buy_material",
                title: "Buy Iron Ore",
                executable: false,
                payload: {},
                steps: ["Open Iron Ore.", "Buy 100 units."]
              }
            ]
          }
        ],
        marketSignals: [],
        stockoutRisks: [],
        expansionCandidates: [],
        logisticsMoves: [],
        warnings: [],
        situation: {
          cash: { status: "low", score: 15, summary: "$50,000 cash available.", current: 5000000 },
          production: { status: "high", score: 72, summary: "1 material risk, 0 critical." },
          logistics: { status: "medium", score: 45, summary: "1 feasible transfer." },
          market: { status: "medium", score: 52, summary: "1 actionable market signal." },
          expansion: { status: "low", score: 20, summary: "No structural expansion pressure." },
          dataQuality: { status: "low", score: 5, summary: "No snapshot warnings.", warnings: [] }
        },
        rawSnapshot: { company: { name: "Test Co" } }
      }
    });
  });

  await page.goto("/");
  await page.getByLabel("Galactic Tycoons API key").fill("gt-test-key");
  await page.getByLabel("OpenAI API key").fill("sk-test-key");
  await page.getByRole("button", { name: "Start Session" }).click();

  await expect(page.getByText("Session active")).toBeVisible();
  await expect(page.getByLabel("Model")).toHaveValue("gpt-5.5-mini");
  await page.getByLabel("Command prompt").fill("Give me a restock-focused sitrep before my next login.");
  await page.getByRole("button", { name: "Generate Sitrep" }).click();
  await expect(page.getByText("Restock Iron Ore")).toBeVisible();
  await expect(page.getByText("Restock inputs and review exchange pricing.")).toBeVisible();
  await expect(page.getByText("1 material risk, 0 critical.")).toBeVisible();
  await expect(page.getByText("Why this is ranked:")).toBeVisible();
  await expect(page.getByText("84")).toBeVisible();
});

test("full OpenAI model remains selectable", async ({ page }) => {
  await page.route("**/api/session/keys", async (route) => {
    await route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/session/models?provider=openai&refresh=false", async (route) => {
    await route.fulfill({
      json: {
        provider: "openai",
        defaultModel: "gpt-5.5-mini",
        models: [
          { id: "gpt-5.5-mini", label: "gpt-5.5-mini", source: "provider" },
          { id: "gpt-5.5", label: "gpt-5.5", source: "provider" }
        ],
        warnings: []
      }
    });
  });
  await page.route("**/api/agent/sitrep", async (route) => {
    const payload = route.request().postDataJSON();
    expect(payload.model).toBe("gpt-5.5");
    await route.fulfill({
      json: {
        generatedAt: new Date().toISOString(),
        provider: "openai",
        model: "gpt-5.5",
        summary: "Full model was selected explicitly.",
        actionPlans: [],
        marketSignals: [],
        stockoutRisks: [],
        expansionCandidates: [],
        logisticsMoves: [],
        warnings: [],
        rawSnapshot: { fetchedAt: new Date().toISOString(), company: { name: "Test Co" } }
      }
    });
  });

  await page.goto("/");
  await page.getByLabel("Galactic Tycoons API key").fill("gt-test-key");
  await page.getByLabel("OpenAI API key").fill("sk-test-key");
  await page.getByRole("button", { name: "Start Session" }).click();

  await expect(page.getByLabel("Model")).toHaveValue("gpt-5.5-mini");
  await expect(page.getByText("Fast OpenAI models are selected by default.")).toBeVisible();
  await page.locator(".console-panel .control-grid select").nth(1).selectOption("gpt-5.5");
  await expect(page.getByText("Large model selected. This can wait up to 12 minutes.")).toBeVisible();
  await page.getByLabel("Command prompt").fill("Use the full model for this plan.");
  await page.getByRole("button", { name: "Generate Sitrep" }).click();
  await expect(page.getByText("Full model was selected explicitly.")).toBeVisible();
});

test("LLM timeout error remains visible without clearing the dashboard", async ({ page }) => {
  let sitrepCalls = 0;
  await page.route("**/api/session/keys", async (route) => {
    await route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/session/models?provider=openai&refresh=false", async (route) => {
    await route.fulfill({
      json: {
        provider: "openai",
        defaultModel: "gpt-5.5-mini",
        models: [
          { id: "gpt-5.5-mini", label: "gpt-5.5-mini", source: "provider" },
          { id: "gpt-5.5", label: "gpt-5.5", source: "provider" }
        ],
        warnings: []
      }
    });
  });
  await page.route("**/api/agent/sitrep", async (route) => {
    sitrepCalls += 1;
    if (sitrepCalls === 1) {
      await route.fulfill({
        json: {
          generatedAt: new Date().toISOString(),
          provider: "openai",
          model: "gpt-5.5-mini",
          summary: "Fast model generated the current dashboard.",
          actionPlans: [],
          marketSignals: [],
          stockoutRisks: [],
          expansionCandidates: [],
          logisticsMoves: [],
          warnings: [],
          rawSnapshot: { fetchedAt: new Date().toISOString(), company: { name: "Test Co" } }
        }
      });
      return;
    }

    await route.fulfill({
      status: 504,
      json: {
        error: "OpenAI did not respond within 12m. Try a faster model or another provider.",
        details: { provider: "openai", model: "gpt-5.5", timeoutMs: 720000, timeout: "12m" }
      }
    });
  });

  await page.goto("/");
  await page.getByLabel("Galactic Tycoons API key").fill("gt-test-key");
  await page.getByLabel("OpenAI API key").fill("sk-test-key");
  await page.getByRole("button", { name: "Start Session" }).click();

  await page.getByLabel("Command prompt").fill("Generate a fast model dashboard first.");
  await page.getByRole("button", { name: "Generate Sitrep" }).click();
  await expect(page.getByText("Fast model generated the current dashboard.")).toBeVisible();

  await page.locator(".console-panel .control-grid select").nth(1).selectOption("gpt-5.5");
  await expect(page.getByText("Large model selected. This can wait up to 12 minutes.")).toBeVisible();
  await page.getByLabel("Command prompt").fill("Try the large model.");
  await page.getByRole("button", { name: "Generate Sitrep" }).click();
  await expect(page.getByText("OpenAI did not respond within 12m. Try a faster model or another provider.")).toBeVisible();
  await expect(page.getByText("Fast model generated the current dashboard.")).toBeVisible();
});

test("model catalog failure keeps fallback models available", async ({ page }) => {
  await page.route("**/api/session/keys", async (route) => {
    await route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/session/models?provider=openai&refresh=false", async (route) => {
    await route.fulfill({ status: 500, json: { error: "Could not load provider models." } });
  });
  await page.route("**/api/agent/sitrep", async (route) => {
    await route.fulfill({
      json: {
        generatedAt: new Date().toISOString(),
        provider: "openai",
        model: "gpt-5.5-mini",
        summary: "Fallback model still generated a sitrep.",
        actionPlans: [],
        marketSignals: [],
        stockoutRisks: [],
        expansionCandidates: [],
        logisticsMoves: [],
        warnings: [],
        rawSnapshot: { fetchedAt: new Date().toISOString(), company: { name: "Test Co" } }
      }
    });
  });

  await page.goto("/");
  await page.getByLabel("Galactic Tycoons API key").fill("gt-test-key");
  await page.getByLabel("OpenAI API key").fill("sk-test-key");
  await page.getByRole("button", { name: "Start Session" }).click();

  await expect(page.getByText("Could not load provider models.")).toBeVisible();
  await expect(page.getByLabel("Model")).toHaveValue("gpt-5.5-mini");
  await page.getByLabel("Command prompt").fill("Give me a fallback model sitrep.");
  await page.getByRole("button", { name: "Generate Sitrep" }).click();
  await expect(page.getByText("Fallback model still generated a sitrep.")).toBeVisible();
});

test("custom model override is sent with the prompt request", async ({ page }) => {
  await page.route("**/api/session/keys", async (route) => {
    await route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/session/models?provider=openai&refresh=false", async (route) => {
    await route.fulfill({
      json: {
        provider: "openai",
        defaultModel: "gpt-5.5-mini",
        models: [{ id: "gpt-5.5-mini", label: "gpt-5.5-mini", source: "provider" }],
        warnings: []
      }
    });
  });
  await page.route("**/api/agent/sitrep", async (route) => {
    const payload = route.request().postDataJSON();
    expect(payload.model).toBe("gpt-experimental-sitrep");
    expect(payload.planningContext.userPrompt).toBe("Use my custom model for this cargo plan.");
    await route.fulfill({
      json: {
        generatedAt: new Date().toISOString(),
        provider: "openai",
        model: "gpt-experimental-sitrep",
        summary: "Custom model generated a logistics plan.",
        actionPlans: [],
        marketSignals: [],
        stockoutRisks: [],
        expansionCandidates: [],
        logisticsMoves: [],
        warnings: [],
        rawSnapshot: { fetchedAt: new Date().toISOString(), company: { name: "Test Co" } }
      }
    });
  });

  await page.goto("/");
  await page.getByLabel("Galactic Tycoons API key").fill("gt-test-key");
  await page.getByLabel("OpenAI API key").fill("sk-test-key");
  await page.getByRole("button", { name: "Start Session" }).click();

  await page.getByLabel("Model").selectOption("__custom");
  await page.getByRole("textbox", { name: "Custom model ID" }).fill("gpt-experimental-sitrep");
  await page.getByLabel("Command prompt").fill("Use my custom model for this cargo plan.");
  await page.getByRole("button", { name: "Generate Sitrep" }).click();

  await expect(page.getByText("Custom model generated a logistics plan.")).toBeVisible();
});

test("gemini provider dashboard renders deterministic tabs after synthesis", async ({ page }) => {
  await page.route("**/api/session/keys", async (route) => {
    await route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/session/models?provider=gemini&refresh=false", async (route) => {
    await route.fulfill({
      json: {
        provider: "gemini",
        defaultModel: "gemini-2.5-flash",
        models: [{ id: "gemini-2.5-flash", label: "gemini-2.5-flash", source: "provider" }],
        warnings: []
      }
    });
  });
  await page.route("**/api/agent/sitrep", async (route) => {
    const payload = route.request().postDataJSON();
    expect(payload.provider).toBe("gemini");
    expect(payload.model).toBe("gemini-2.5-flash");
    await route.fulfill({
      json: {
        generatedAt: new Date().toISOString(),
        provider: "gemini",
        model: "gemini-2.5-flash",
        summary: "Gemini synthesized the plan while preserving deterministic tables.",
        actionPlans: [],
        marketSignals: [
          {
            matId: 1,
            matName: "Hydrogen",
            currentPrice: 150,
            avgPrice: 200,
            spreadPct: -25,
            trend: "down",
            recommendation: "buy",
            rationale: ["Below average and useful for restocking."]
          }
        ],
        stockoutRisks: [],
        expansionCandidates: [
          {
            title: "Build storage buffer",
            type: "warehouse",
            priority: "high",
            requiredMaterials: [],
            blockers: [],
            rationale: ["Warehouse pressure is visible."],
            preparedCommands: []
          }
        ],
        logisticsMoves: [],
        warnings: [],
        rawSnapshot: { fetchedAt: new Date().toISOString(), company: { name: "Test Co" } }
      }
    });
  });

  await page.goto("/");
  await page.getByLabel("Galactic Tycoons API key").fill("gt-test-key");
  await page.getByLabel("Provider").selectOption("gemini");
  await page.getByLabel("Gemini API key").fill("gemini-test-key");
  await page.getByRole("button", { name: "Start Session" }).click();

  await expect(page.getByLabel("Model")).toHaveValue("gemini-2.5-flash");
  await page.getByLabel("Command prompt").fill("Use Gemini for the next 12 hour plan.");
  await page.getByRole("button", { name: "Generate Sitrep" }).click();
  await expect(page.getByText("Gemini synthesized the plan while preserving deterministic tables.")).toBeVisible();

  await page.getByRole("button", { name: "Market" }).click();
  await expect(page.getByText("Hydrogen")).toBeVisible();
  await page.getByRole("button", { name: "Expansion" }).click();
  await expect(page.getByText("Build storage buffer")).toBeVisible();
});
