import { expect, test } from "@playwright/test";

test("setup and sitrep dashboard flow", async ({ page }) => {
  await page.route("**/api/session/keys", async (route) => {
    await route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/session/models?provider=openai&refresh=false", async (route) => {
    await route.fulfill({
      json: {
        provider: "openai",
        defaultModel: "gpt-5.5",
        models: [
          { id: "gpt-5.5", label: "gpt-5.5", source: "provider" },
          { id: "gpt-5.4-mini", label: "gpt-5.4-mini", source: "provider" }
        ],
        warnings: []
      }
    });
  });
  await page.route("**/api/agent/sitrep", async (route) => {
    const payload = route.request().postDataJSON();
    expect(payload.model).toBe("gpt-5.5");
    expect(payload.planningContext.userPrompt).toContain("restock");
    expect(payload.refresh).toEqual({ forceCompany: true, forceMarket: true, forceGameData: false });
    await route.fulfill({
      json: {
        generatedAt: new Date().toISOString(),
        provider: "openai",
        model: "gpt-5.5",
        summary: "Restock inputs and review exchange pricing.",
        actionPlans: [
          {
            id: "restock-1",
            title: "Restock Iron Ore",
            priority: "high",
            category: "operations",
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
        rawSnapshot: { company: { name: "Test Co" } }
      }
    });
  });

  await page.goto("/");
  await page.getByLabel("Galactic Tycoons API key").fill("gt-test-key");
  await page.getByLabel("OpenAI API key").fill("sk-test-key");
  await page.getByRole("button", { name: "Start Session" }).click();

  await expect(page.getByText("Session active")).toBeVisible();
  await expect(page.getByLabel("Model")).toHaveValue("gpt-5.5");
  await page.getByLabel("Command prompt").fill("Give me a restock-focused sitrep before my next login.");
  await page.getByRole("button", { name: "Generate Sitrep" }).click();
  await expect(page.getByText("Restock Iron Ore")).toBeVisible();
  await expect(page.getByText("Restock inputs and review exchange pricing.")).toBeVisible();
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
        model: "gpt-5.5",
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
  await expect(page.getByLabel("Model")).toHaveValue("gpt-5.5");
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
        defaultModel: "gpt-5.5",
        models: [{ id: "gpt-5.5", label: "gpt-5.5", source: "provider" }],
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
