import { expect, test } from "@playwright/test";

test("setup and sitrep dashboard flow", async ({ page }) => {
  await page.route("**/api/session/keys", async (route) => {
    await route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/agent/sitrep", async (route) => {
    await route.fulfill({
      json: {
        generatedAt: new Date().toISOString(),
        provider: "openai",
        model: "gpt-4o-mini",
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
  await page.getByRole("button", { name: "Generate Sitrep" }).click();
  await expect(page.getByText("Restock Iron Ore")).toBeVisible();
  await expect(page.getByText("Restock inputs and review exchange pricing.")).toBeVisible();
});
