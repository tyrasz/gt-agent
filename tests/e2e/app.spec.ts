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
        decisionBrief: {
          thesis: "Restock Iron Ore first, then inspect whether the next CV move should be production capacity or market repricing.",
          recommendedPath: [
            "1. Restock Iron Ore before the next login.",
            "2. Confirm exchange depth before buying.",
            "3. Review CV growth options after production is covered."
          ],
          whyThisPath: ["Iron Ore has visible demand.", "Production stability should come before speculative CV spending."],
          alternatives: [
            {
              title: "Deepen current specialization",
              pros: ["Lower setup risk."],
              cons: ["Needs confirmed input coverage."],
              chooseWhen: "Choose when current recipes still have margin."
            },
            {
              title: "Diversify into another industry",
              pros: ["Can open new markets."],
              cons: ["Higher setup risk."],
              chooseWhen: "Choose when a new chain beats current margins."
            }
          ],
          constraints: ["GT Agent is read-only.", "Cash and prices must be checked live."],
          inspectNext: ["Open base plans.", "Refresh Iron Ore market depth."],
          confidence: "medium"
        },
        actionPlans: [
          {
            id: "restock-1",
            title: "Restock Iron Ore",
            priority: "high",
            category: "operations",
            score: 84,
            confidence: "high",
            horizonId: "h12",
            horizonLabel: "Next 12h",
            latestUsefulByHours: 12,
            whyNow: "Iron Ore coverage is inside the 12-hour planning window.",
            bestWhen: "Use this while the order book still matches the snapshot.",
            avoidIf: "Avoid if live prices jump.",
            whatWouldChangeThis: "A fresh stock snapshot could reduce the buy.",
            futureTriggers: ["Iron Ore remains short by the next login."],
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
          },
          {
            id: "profit-run_now-1001",
            title: "Run profitable Iron Bar",
            priority: "medium",
            category: "profitability",
            score: 62,
            confidence: "medium",
            horizonId: "h12",
            horizonLabel: "Next 12h",
            latestUsefulByHours: 12,
            profitPerHour: 200000,
            marginPct: 50,
            profitabilityTag: "company-fit",
            whyNow: "Use existing production fit if live inputs and output prices still support $2,000/h.",
            expectedBenefit: "$2,000/h estimated net value at 50% margin.",
            costSummary: "No major setup gap visible from the read-only snapshot.",
            risk: "Profitability can collapse if input prices rise.",
            evidence: ["$2,000/h estimated net value.", "100% one-run input coverage."],
            preparedCommands: []
          }
        ],
        profitability: {
          recipes: [
            {
              recipeId: 1001,
              recipeName: "Iron Bar recipe",
              outputMatId: 2,
              outputMatName: "Iron Bar",
              inputMatIds: [1],
              buildingId: 10,
              buildingName: "Smelter",
              industry: "Metallurgy",
              inputCostPerHour: 400000,
              outputValuePerHour: 600000,
              grossProfitPerHour: 200000,
              netEstimatePerHour: 200000,
              marginPct: 50,
              profitPer100Burden: 2000000,
              outputUnitsPerHour: 50,
              inputCoveragePct: 100,
              liquidityScore: 55,
              priceConfidence: "high",
              companyFit: "active",
              setupCostEstimate: 100000,
              setupGaps: [],
              warnings: []
            },
            {
              recipeId: 2001,
              recipeName: "Tools recipe",
              outputMatId: 3,
              outputMatName: "Tools",
              inputMatIds: [2],
              buildingId: 20,
              buildingName: "Toolworks",
              industry: "Manufacturing",
              inputCostPerHour: 120000,
              outputValuePerHour: 600000,
              grossProfitPerHour: 480000,
              netEstimatePerHour: 480000,
              marginPct: 400,
              outputUnitsPerHour: 100,
              inputCoveragePct: 100,
              liquidityScore: 25,
              priceConfidence: "medium",
              companyFit: "target",
              setupCostEstimate: 700000,
              setupGaps: ["Build or acquire Toolworks."],
              warnings: ["Tools uses CP fallback for output price."]
            }
          ],
          companyFit: [
            {
              id: "profit-company-1001",
              kind: "run_now",
              recipeId: 1001,
              title: "Run profitable Iron Bar",
              recommendation: "Use existing production fit if live inputs and output prices still support $2,000/h.",
              horizonId: "h12",
              horizonLabel: "Next 12h",
              score: 62,
              confidence: "medium",
              profitPerHour: 200000,
              marginPct: 50,
              rationale: ["$2,000/h estimated net value.", "100% one-run input coverage."],
              blockers: []
            }
          ],
          globalTargets: [
            {
              id: "profit-global-2001",
              kind: "restructure_toward",
              recipeId: 2001,
              title: "Restructure toward Tools",
              recommendation: "Treat Tools as a long-horizon target if live margins persist.",
              horizonId: "d7",
              horizonLabel: "7 Days",
              score: 88,
              confidence: "medium",
              profitPerHour: 480000,
              marginPct: 400,
              rationale: ["$4,800/h estimated net production value.", "Requires Toolworks."],
              blockers: ["Build or acquire Toolworks."]
            }
          ],
          assumptions: ["Profitability uses current exchange prices when available and material CP as fallback."],
          warnings: []
        },
        projections: {
          horizons: [
            { id: "h12", label: "Next 12h", hours: 12 },
            { id: "d1", label: "1 Day", hours: 24 },
            { id: "d3", label: "3 Days", hours: 72 },
            { id: "d7", label: "7 Days", hours: 168 }
          ],
          materialNeeds: [
            {
              horizonId: "h12",
              horizonLabel: "Next 12h",
              hours: 12,
              matId: 1,
              matName: "Iron Ore",
              requiredQty: 120,
              availableQty: 20,
              netNeedQty: 100,
              tonnes: 100
            }
          ],
          bands: [
            {
              horizonId: "h12",
              summary: "Next 12h: projected 100 Iron Ore net need.",
              confidence: "high",
              actionIds: ["restock-1", "profit-run_now-1001"],
              materialNeeds: [
                {
                  horizonId: "h12",
                  horizonLabel: "Next 12h",
                  hours: 12,
                  matId: 1,
                  matName: "Iron Ore",
                  requiredQty: 120,
                  availableQty: 20,
                  netNeedQty: 100,
                  tonnes: 100
                }
              ],
              constraints: ["Iron Ore is the expected bottleneck before the next login."],
              inspectNext: ["Verify live Iron Ore supply before buying."]
            },
            {
              horizonId: "d1",
              summary: "1 Day: stabilize the same input before it becomes repeat pressure.",
              confidence: "high",
              actionIds: ["restock-1"],
              materialNeeds: [],
              constraints: ["Production should be rechecked after the first restock."],
              inspectNext: ["Confirm production queue after restocking."]
            },
            {
              horizonId: "d3",
              summary: "3 Days: review base plans only after input coverage is proven.",
              confidence: "medium",
              actionIds: [],
              materialNeeds: [],
              constraints: ["Longer-horizon projections assume production keeps repeating."],
              inspectNext: ["Review base plans and storage."]
            },
            {
              horizonId: "d7",
              summary: "7 Days: keep expansion preparatory unless the 3-day checks reveal a bottleneck.",
              confidence: "low",
              actionIds: [],
              materialNeeds: [],
              constraints: ["Long-range demand has lower confidence."],
              inspectNext: ["Re-run GT Agent before committing a week-long plan."]
            }
          ],
          warnings: ["Long-range projections assume active production repeats."]
        },
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
  await expect(page.getByRole("heading", { name: "Restock Iron Ore", exact: true })).toBeVisible();
  await expect(page.getByText("Restock inputs and review exchange pricing.")).toBeVisible();
  await expect(page.getByRole("heading", { name: /Restock Iron Ore first/ })).toBeVisible();
  await expect(page.getByText("Recommended path")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Projection roadmap" })).toBeVisible();
  await expect(page.getByText("Next 12h").first()).toBeVisible();
  await expect(page.getByText("Material pressure")).toBeVisible();
  await expect(page.getByText("Iron Ore: 100 net")).toBeVisible();
  await expect(page.getByText("Expected bottleneck").first()).toBeVisible();
  await expect(page.getByText("Best when:")).toBeVisible();
  await expect(page.getByText("1 material risk, 0 critical.")).toBeVisible();
  await expect(page.getByText("Why this is ranked:").first()).toBeVisible();
  await expect(page.getByText("84")).toBeVisible();
  await expect(page.getByText("$2,000/h", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Profitability" }).click();
  await expect(page.getByRole("heading", { name: "Company-fit now" })).toBeVisible();
  await expect(page.getByText("Run profitable Iron Bar")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Global targets to restructure toward" })).toBeVisible();
  await expect(page.getByText("Restructure toward Tools")).toBeVisible();
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

test("CV growth prompt renders decision alternatives and inspection checklist", async ({ page }) => {
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
    expect(payload.planningContext.userPrompt).toContain("increase my CV");
    await route.fulfill({
      json: {
        generatedAt: new Date().toISOString(),
        provider: "openai",
        model: "gpt-5.5-mini",
        summary: "CV growth needs a prepared path, not a blind spend.",
        decisionBrief: {
          thesis: "Increase CV by comparing deeper specialization against diversification before committing cash.",
          recommendedPath: ["1. Hold major spending.", "2. Compare specialization and diversification.", "3. Commit to the better margin path."],
          whyThisPath: ["No urgent bottleneck is visible.", "Expansion material requirements are unknown."],
          alternatives: [
            {
              title: "Deepen current specialization",
              pros: ["Lower setup risk."],
              cons: ["Depends on current lane margin."],
              chooseWhen: "Choose when the current lane has strong recipe margin."
            },
            {
              title: "Diversify into another industry",
              pros: ["Opens new demand."],
              cons: ["Higher setup risk."],
              chooseWhen: "Choose when a new chain clearly beats current returns."
            }
          ],
          constraints: ["Expansion material requirements are unknown."],
          inspectNext: ["For CV growth, compare recipe margin, input availability, facility cost, and sell demand."],
          confidence: "medium"
        },
        projections: {
          horizons: [
            { id: "h12", label: "Next 12h", hours: 12 },
            { id: "d1", label: "1 Day", hours: 24 },
            { id: "d3", label: "3 Days", hours: 72 },
            { id: "d7", label: "7 Days", hours: 168 }
          ],
          materialNeeds: [],
          bands: [
            {
              horizonId: "h12",
              summary: "Next 12h: no urgent CV spend is justified.",
              confidence: "high",
              actionIds: [],
              materialNeeds: [],
              constraints: ["No immediate production or logistics bottleneck is visible."],
              inspectNext: ["Confirm current production margins."]
            },
            {
              horizonId: "d1",
              summary: "1 Day: compare the current specialization lane against one diversification candidate.",
              confidence: "high",
              actionIds: [],
              materialNeeds: [],
              constraints: ["Facility and input costs decide whether CV growth should stay specialized."],
              inspectNext: ["Check input availability for the current lane."]
            },
            {
              horizonId: "d3",
              summary: "3 Days: prepare base-plan material checks if the margin comparison is favorable.",
              confidence: "medium",
              actionIds: [],
              materialNeeds: [],
              constraints: ["Expansion material requirements are unknown."],
              inspectNext: ["Open base plans and record required materials."]
            },
            {
              horizonId: "d7",
              summary: "7 Days: commit to specialization or diversification only after repeated snapshots confirm demand.",
              confidence: "low",
              actionIds: [],
              materialNeeds: [],
              constraints: ["Week-long CV projections are preparation guidance, not execution commands."],
              inspectNext: ["Re-run the snapshot after market and base-plan checks."]
            }
          ],
          warnings: ["Expansion projections are preparatory until base-plan material requirements are known."]
        },
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

  await page.getByLabel("Command prompt").fill("Give me next steps to increase my CV.");
  await page.getByRole("button", { name: "Generate Sitrep" }).click();
  await expect(page.getByText("Increase CV by comparing deeper specialization against diversification before committing cash.")).toBeVisible();
  await page.getByText("Alternatives").click();
  await expect(page.getByText("Deepen current specialization")).toBeVisible();
  await expect(page.getByText("Diversify into another industry")).toBeVisible();
  await expect(page.getByText("1 Day: compare the current specialization lane against one diversification candidate.")).toBeVisible();
  await expect(page.getByText("3 Days: prepare base-plan material checks if the margin comparison is favorable.")).toBeVisible();
  await expect(page.getByText("7 Days: commit to specialization or diversification only after repeated snapshots confirm demand.")).toBeVisible();
  await page.getByLabel("Decision Brief").getByText("Inspect next").click();
  await expect(page.getByText("For CV growth, compare recipe margin")).toBeVisible();
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
