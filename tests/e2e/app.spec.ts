import { expect, test } from "@playwright/test";

function mockOperationsBrief() {
  return {
    expectedIncome: {
      horizonHours: 12,
      grossOutputValue: 7200000,
      inputCost: 4800000,
      netProfit: 2400000,
      confidence: "high",
      assumptions: [
        "Forecast assumes visible active production orders keep running for the next 12 hours.",
        "Prices use current market values first and material CP fallback second."
      ],
      lines: [
        {
          id: "income-1001-alpha",
          baseName: "Alpha",
          recipeId: 1001,
          recipeName: "Iron Bar recipe",
          orderCount: 1,
          outputMatId: 2,
          outputMatName: "Iron Bar",
          grossOutputValue: 7200000,
          inputCost: 4800000,
          netProfit: 2400000,
          marginPct: 50,
          confidence: "high",
          priceSources: ["Iron Bar: market", "Iron Ore: market"],
          assumptions: ["1 active production order(s) at Alpha.", "12 recipe cycle(s) projected over 12h."]
        }
      ]
    },
    problems: [
      {
        id: "buffer-1",
        type: "production_bottleneck",
        severity: "high",
        title: "Iron Ore below 8h input buffer",
        summary: "2h covered; buy 100 units to reach 8h.",
        evidence: ["20 owned vs 120 target.", "Estimated fill cost $4,000."],
        actionId: "buffer-1"
      }
    ],
    bufferPlan: {
      targetHours: 8,
      totalFillCost: 400000,
      materials: [
        {
          matId: 1,
          matName: "Iron Ore",
          targetHours: 8,
          coverageHours: 2,
          targetQty: 120,
          ownedQty: 20,
          buyQty: 100,
          estimatedCost: 400000,
          priceSource: "market",
          urgency: "high",
          affectedBases: ["Alpha"]
        }
      ],
      warnings: []
    },
    surplusPlans: [
      {
        matId: 2,
        matName: "Iron Bar",
        surplusQty: 300,
        surplusValue: 1800000,
        priceSource: "market",
        recommendation: "reprice",
        confidence: "high",
        reason: "Surplus is already exchange-exposed and the premium is material enough to review repricing.",
        actionId: "surplus-2"
      }
    ]
  };
}

test("setup and sitrep dashboard flow", async ({ page }) => {
  await page.route("**/api/session/keys", async (route) => {
    await route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/session/models?provider=openai&refresh=false", async (route) => {
    await route.fulfill({
      json: {
        provider: "openai",
        defaultModel: "gpt-4.1-mini",
        models: [
          { id: "gpt-4.1-mini", label: "gpt-4.1-mini", source: "provider" },
          { id: "gpt-4o-mini", label: "gpt-4o-mini", source: "provider" },
          { id: "gpt-5", label: "gpt-5", source: "provider" }
        ],
        warnings: []
      }
    });
  });
  await page.route("**/api/agent/sitrep", async (route) => {
    const payload = route.request().postDataJSON();
    expect(payload.model).toBe("gpt-4.1-mini");
    expect(payload.planningContext.userPrompt).toContain("restock");
    expect(payload.refresh).toEqual({ forceCompany: true, forceMarket: true, forceGameData: false });
    await route.fulfill({
      json: {
        generatedAt: new Date().toISOString(),
        provider: "openai",
        model: "gpt-4.1-mini",
        summary: "Restock inputs and review exchange pricing.",
        operationsBrief: mockOperationsBrief(),
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
        decisionPanel: {
          summary: "2 contract/exchange decisions ranked (1 contract, 1 exchange), led by Fulfill Iron Ore Rush.",
          warnings: [],
          actions: [
            {
              id: "contract-ore-rush",
              kind: "contract",
              action: "fulfill_contract",
              title: "Fulfill Iron Ore Rush",
              priority: "high",
              score: 82,
              confidence: "high",
              expectedValue: 1000000,
              cashImpactPct: 0,
              deadline: "2030-01-01T00:00:00.000Z",
              requirements: [
                {
                  matId: 1,
                  matName: "Iron Ore",
                  quantity: 10,
                  availableQty: 20,
                  shortageQty: 0,
                  estimatedCost: 0
                }
              ],
              blockers: [],
              evidence: ["Payout: $10,000.", "Visible inventory covers parsed requirements."],
              preparedCommands: [
                {
                  type: "review",
                  title: "Review contract: Iron Ore Rush",
                  executable: false,
                  payload: {},
                  steps: ["Open contract Iron Ore Rush.", "Confirm payout and requirements."]
                }
              ]
            },
            {
              id: "exchange-buy-1",
              kind: "exchange",
              action: "buy_material",
              title: "Buy Iron Ore",
              priority: "medium",
              score: 58,
              confidence: "medium",
              expectedValue: 100000,
              cashImpactPct: 8,
              requirements: [
                {
                  matId: 1,
                  matName: "Iron Ore",
                  quantity: 100,
                  availableQty: 20,
                  shortageQty: 100,
                  estimatedCost: 400000
                }
              ],
              blockers: [],
              evidence: ["$40 current vs $50 recent average (-20%).", "100 net needed by current production/wishlist demand."],
              preparedCommands: [
                {
                  type: "buy_material",
                  title: "Check buy quantity for Iron Ore",
                  executable: false,
                  payload: {},
                  steps: ["Open Iron Ore.", "Check quantity.", "Buy only if live depth matches."]
                }
              ]
            }
          ]
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
            capitalFit: "affordable",
            setupDistance: "ready",
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
              capitalFit: "affordable",
              setupDistance: "ready",
              setupCostEstimate: 0,
              firstPracticalStep: "Run or reprice Iron Bar using existing production fit.",
              missingPrerequisites: [],
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
              capitalFit: "stretch",
              setupDistance: "unreachable_now",
              setupCostEstimate: 700000,
              cashImpactPct: 38,
              firstPracticalStep: "Treat Tools as a stretch; validate setup cost before spending.",
              missingPrerequisites: ["Build or acquire Toolworks."],
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
              capitalFit: "affordable",
              setupDistance: "ready",
              setupCostEstimate: 0,
              firstPracticalStep: "Run or reprice Iron Bar using existing production fit.",
              missingPrerequisites: [],
              rationale: ["$2,000/h estimated net value.", "100% one-run input coverage."],
              blockers: []
            }
          ],
          nextSteps: [],
          aspirationalTargets: [
            {
              id: "profit-global-2001",
              kind: "restructure_toward",
              recipeId: 2001,
              title: "Restructure toward Tools",
              recommendation: "Treat Tools as aspirational until capital and setup blockers are cleared.",
              horizonId: "d7",
              horizonLabel: "7 Days",
              score: 88,
              confidence: "medium",
              profitPerHour: 480000,
              marginPct: 400,
              capitalFit: "stretch",
              setupDistance: "unreachable_now",
              setupCostEstimate: 700000,
              cashImpactPct: 38,
              firstPracticalStep: "Treat Tools as a stretch; validate setup cost before spending.",
              missingPrerequisites: ["Build or acquire Toolworks."],
              rationale: ["$4,800/h estimated net production value.", "Requires Toolworks."],
              blockers: ["Build or acquire Toolworks."]
            }
          ],
          blockedTargets: [
            {
              id: "profit-global-9001",
              kind: "restructure_toward",
              recipeId: 9001,
              title: "Restructure toward Uranium Ore",
              recommendation: "Keep Uranium Ore as a blocked long-term reference until planet/resource, tech, and capital blockers are cleared.",
              horizonId: "d7",
              horizonLabel: "7 Days",
              score: 35,
              confidence: "low",
              profitPerHour: 12000000,
              capitalFit: "blocked",
              setupDistance: "unreachable_now",
              resourceAccess: "blocked",
              planetRequirement: "Requires a planet/base with Uranium Ore resource access.",
              techRequirement: "Requires research level 15 before Uranium Mine can be treated as available.",
              setupCostCompleteness: "partial",
              setupCostEstimate: 100000000,
              knownMinimumCapital: 119500000,
              knownCapitalGap: 114500000,
              cashImpactPct: 2000,
              firstPracticalStep: "Do not plan Uranium Ore as a next move until blocked prerequisites are resolved. Known minimum capital before unpriced gaps is $1,195,000.",
              missingPrerequisites: ["Confirm planet/resource access for Uranium Ore.", "Confirm research requirement 15."],
              unpricedRequirements: [
                "New planet/base/resource access for Uranium Ore is not priced from the current snapshot.",
                "Research path cost for requirement 15 is not priced from the current snapshot."
              ],
              blockingReasons: [
                "Requires a planet/base with Uranium Ore resource access.",
                "Requires research level 15 before Uranium Mine can be treated as available."
              ],
              rationale: [
                "$120,000/h estimated net production value.",
                "Known minimum capital is $1,195,000 before unpriced gaps."
              ],
              blockers: [
                "Requires a planet/base with Uranium Ore resource access.",
                "Requires research level 15 before Uranium Mine can be treated as available."
              ]
            }
          ],
          globalTargets: [
            {
              id: "profit-global-2001",
              kind: "restructure_toward",
              recipeId: 2001,
              title: "Restructure toward Tools",
              recommendation: "Treat Tools as aspirational until capital and setup blockers are cleared.",
              horizonId: "d7",
              horizonLabel: "7 Days",
              score: 88,
              confidence: "medium",
              profitPerHour: 480000,
              marginPct: 400,
              capitalFit: "stretch",
              setupDistance: "unreachable_now",
              setupCostEstimate: 700000,
              cashImpactPct: 38,
              firstPracticalStep: "Treat Tools as a stretch; validate setup cost before spending.",
              missingPrerequisites: ["Build or acquire Toolworks."],
              rationale: ["$4,800/h estimated net production value.", "Requires Toolworks."],
              blockers: ["Build or acquire Toolworks."]
            },
            {
              id: "profit-global-9001",
              kind: "restructure_toward",
              recipeId: 9001,
              title: "Restructure toward Uranium Ore",
              recommendation: "Keep Uranium Ore as a blocked long-term reference until planet/resource, tech, and capital blockers are cleared.",
              horizonId: "d7",
              horizonLabel: "7 Days",
              score: 35,
              confidence: "low",
              profitPerHour: 12000000,
              capitalFit: "blocked",
              setupDistance: "unreachable_now",
              resourceAccess: "blocked",
              planetRequirement: "Requires a planet/base with Uranium Ore resource access.",
              techRequirement: "Requires research level 15 before Uranium Mine can be treated as available.",
              setupCostCompleteness: "partial",
              setupCostEstimate: 100000000,
              knownMinimumCapital: 119500000,
              knownCapitalGap: 114500000,
              cashImpactPct: 2000,
              firstPracticalStep: "Do not plan Uranium Ore as a next move until blocked prerequisites are resolved. Known minimum capital before unpriced gaps is $1,195,000.",
              missingPrerequisites: ["Confirm planet/resource access for Uranium Ore.", "Confirm research requirement 15."],
              unpricedRequirements: [
                "New planet/base/resource access for Uranium Ore is not priced from the current snapshot.",
                "Research path cost for requirement 15 is not priced from the current snapshot."
              ],
              blockingReasons: [
                "Requires a planet/base with Uranium Ore resource access.",
                "Requires research level 15 before Uranium Mine can be treated as available."
              ],
              rationale: [
                "$120,000/h estimated net production value.",
                "Known minimum capital is $1,195,000 before unpriced gaps."
              ],
              blockers: [
                "Requires a planet/base with Uranium Ore resource access.",
                "Requires research level 15 before Uranium Mine can be treated as available."
              ]
            }
          ],
          chains: [
            {
              id: "chain-1001-2001",
              title: "Iron Bar -> Tools",
              recipeIds: [1001, 2001],
              outputMatId: 3,
              outputMatName: "Tools",
              steps: [
                {
                  recipeId: 1001,
                  recipeName: "Iron Bar recipe",
                  outputMatId: 2,
                  outputMatName: "Iron Bar",
                  buildingName: "Smelter",
                  netEstimatePerHour: 200000,
                  marginPct: 50,
                  companyFit: "active",
                  capitalFit: "affordable",
                  setupDistance: "ready",
                  setupGaps: []
                },
                {
                  recipeId: 2001,
                  recipeName: "Tools recipe",
                  outputMatId: 3,
                  outputMatName: "Tools",
                  buildingName: "Toolworks",
                  netEstimatePerHour: 480000,
                  marginPct: 400,
                  companyFit: "target",
                  capitalFit: "stretch",
                  setupDistance: "unreachable_now",
                  setupGaps: ["Build or acquire Toolworks."]
                }
              ],
              totalInputCostPerHour: 520000,
              totalOutputValuePerHour: 600000,
              totalNetProfitPerHour: 550000,
              marginPct: 106,
              inputCoveragePct: 100,
              liquidityScore: 25,
              setupGaps: ["Build or acquire Toolworks."],
              companyFit: "target",
              capitalFit: "stretch",
              setupDistance: "unreachable_now",
              setupCostEstimate: 700000,
              cashImpactPct: 38,
              firstPracticalStep: "Treat Tools as a stretch; validate setup cost before spending.",
              missingPrerequisites: ["Build or acquire Toolworks."],
              confidence: "low",
              warnings: []
            }
          ],
          chainOpportunities: [
            {
              id: "chain-opportunity-restructure_chain-chain-1001-2001",
              kind: "restructure_chain",
              chainId: "chain-1001-2001",
              title: "Restructure toward Tools chain",
              recommendation: "Use Tools as a long-horizon chain target if setup gaps and liquidity checks stay favorable.",
              horizonId: "d7",
              horizonLabel: "7 Days",
              score: 76,
              confidence: "medium",
              profitPerHour: 550000,
              marginPct: 106,
              inputCoveragePct: 100,
              capitalFit: "stretch",
              setupDistance: "unreachable_now",
              setupCostEstimate: 700000,
              cashImpactPct: 38,
              firstPracticalStep: "Treat Tools as a stretch; validate setup cost before spending.",
              missingPrerequisites: ["Build or acquire Toolworks."],
              rationale: ["$5,500/h chain net estimate.", "2 linked production steps."],
              blockers: ["Build or acquire Toolworks."]
            }
          ],
          assumptions: ["Profitability uses current exchange prices when available and material CP as fallback."],
          warnings: []
        },
        history: {
          lastRunAt: new Date().toISOString(),
          entries: [
            {
              id: "hist-1",
              generatedAt: new Date().toISOString(),
              fetchedAt: new Date().toISOString(),
              companyName: "Test Co",
              cash: 5000000,
              companyValue: 20000000,
              topActionTitle: "Restock Iron Ore",
              topActionIds: ["restock-1"],
              highPriorityCount: 1,
              stockoutMatIds: [1],
              stockoutMatNames: ["Iron Ore"],
              profitableRecipeIds: [1001],
              profitableRecipeNames: ["Run profitable Iron Bar"],
              marketSignalMatIds: [1],
              marketSignalMatNames: ["Iron Ore"],
              chainIds: ["chain-1001-2001"],
              chainNames: ["Iron Bar -> Tools"],
              warnings: []
            }
          ],
          trendSignals: [
            {
              id: "profit-iron-bar",
              kind: "profitability",
              severity: "positive",
              title: "Persistent profit lane: Run profitable Iron Bar",
              summary: "Run profitable Iron Bar stayed in the profitability set for 2 recent snapshot(s).",
              count: 2,
              actionIds: [],
              evidence: ["2026-05-17T00:00:00.000Z"]
            }
          ]
        },
        trendSignals: [
          {
            id: "profit-iron-bar",
            kind: "profitability",
            severity: "positive",
            title: "Persistent profit lane: Run profitable Iron Bar",
            summary: "Run profitable Iron Bar stayed in the profitability set for 2 recent snapshot(s).",
            count: 2,
            actionIds: [],
            evidence: ["2026-05-17T00:00:00.000Z"]
          }
        ],
        chainOpportunities: [
          {
            id: "chain-opportunity-restructure_chain-chain-1001-2001",
            kind: "restructure_chain",
            chainId: "chain-1001-2001",
            title: "Restructure toward Tools chain",
            recommendation: "Use Tools as a long-horizon chain target if setup gaps and liquidity checks stay favorable.",
            horizonId: "d7",
            horizonLabel: "7 Days",
            score: 76,
            confidence: "medium",
            profitPerHour: 550000,
            marginPct: 106,
            inputCoveragePct: 100,
            capitalFit: "stretch",
            setupDistance: "unreachable_now",
            setupCostEstimate: 700000,
            cashImpactPct: 38,
            firstPracticalStep: "Treat Tools as a stretch; validate setup cost before spending.",
            missingPrerequisites: ["Build or acquire Toolworks."],
            rationale: ["$5,500/h chain net estimate.", "2 linked production steps."],
            blockers: ["Build or acquire Toolworks."]
          }
        ],
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
  await page.route("**/api/agent/what-if", async (route) => {
    const payload = route.request().postDataJSON();
    expect(payload.scenarioType).toBeTruthy();
    await route.fulfill({
      json: {
        generatedAt: new Date().toISOString(),
        scenarioType: payload.scenarioType,
        title: "Stage inputs for Tools",
        baseline: {
          title: "Current baseline",
          summary: "Restock inputs and review exchange pricing.",
          cash: 5000000,
          cashDisplay: "$50,000",
          profitPerHour: 200000,
          profitPerHourDisplay: "$2,000/h",
          materialDeltas: [],
          productionImpact: ["Restock Iron Ore"],
          risk: "low",
          blockers: []
        },
        scenario: {
          title: "Stage inputs for Tools",
          summary: "Uses about $19,000 to prepare a $4,800/h recipe lane.",
          cash: 3100000,
          cashDisplay: "$31,000",
          profitPerHour: 480000,
          profitPerHourDisplay: "$4,800/h",
          materialDeltas: [],
          productionImpact: ["Toolworks requirement should be checked live."],
          risk: "medium",
          blockers: ["Build or acquire Toolworks."]
        },
        deltas: {
          cash: -1900000,
          profitPerHour: 280000,
          materials: []
        },
        recommendedChoice: "defer",
        rationale: ["Defer until blockers are resolved.", "Build or acquire Toolworks."],
        blockers: ["Build or acquire Toolworks."],
        preparedCommands: [
          {
            type: "review",
            title: "Review Tools scenario",
            executable: false,
            payload: {},
            steps: ["Open the recipe for Tools.", "Refresh live input and output prices."]
          }
        ],
        warnings: []
      }
    });
  });

  await page.goto("/");
  await page.getByLabel("Galactic Tycoons API key").fill("gt-test-key");
  await page.getByLabel("OpenAI API key").fill("sk-test-key");
  await page.getByRole("button", { name: "Start Session" }).click();

  await expect(page.getByText("Session active")).toBeVisible();
  await expect(page.getByLabel("Model")).toHaveValue("gpt-4.1-mini");
  await page.getByText("Planning controls").click();
  await expect(page.getByLabel("Input buffer hours")).toHaveValue("8");
  await page.getByLabel("Command prompt").fill("Give me a restock-focused sitrep before my next login.");
  await page.getByRole("button", { name: "Generate Sitrep" }).click();
  await expect(page.getByRole("heading", { name: "Restock Iron Ore", exact: true })).toBeVisible();
  await expect(page.getByText("Restock inputs and review exchange pricing.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Income, bottlenecks, buffer, surplus" })).toBeVisible();
  await expect(page.getByText("12h Net Income")).toBeVisible();
  await expect(page.getByText("Buffer Cost")).toBeVisible();
  await expect(page.getByRole("heading", { name: /Restock Iron Ore first/ })).toBeVisible();
  await expect(page.getByText("Recommended path")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Projection roadmap" })).toBeVisible();
  await expect(page.getByText("Next 12h").first()).toBeVisible();
  await expect(page.getByText("Material pressure")).toBeVisible();
  await expect(page.getByText("Iron Ore: 100 net")).toBeVisible();
  await expect(page.getByText("Expected bottleneck").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "1 run memory" })).toBeVisible();
  await expect(page.getByText("Persistent profit lane: Run profitable Iron Bar")).toBeVisible();
  await expect(page.getByText("Best when:")).toBeVisible();
  await expect(page.getByText("1 material risk, 0 critical.")).toBeVisible();
  await expect(page.getByText("Why this is ranked:").first()).toBeVisible();
  await expect(page.getByText("84")).toBeVisible();
  await expect(page.getByText("$2,000/h", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("affordable").first()).toBeVisible();
  await page.getByRole("button", { name: "Decisions" }).click();
  await expect(page.getByRole("heading", { name: "Fulfill Iron Ore Rush", exact: true })).toBeVisible();
  await expect(page.getByText("contract / fulfill contract")).toBeVisible();
  await expect(page.getByText("Need 10", { exact: true })).toBeVisible();
  await expect(page.getByText("Review contract: Iron Ore Rush")).toBeVisible();
  await expect(page.getByRole("button", { name: "Raw Snapshot" })).toBeVisible();
  await page.getByRole("button", { name: "Profitability" }).click();
  await expect(page.getByRole("heading", { name: "Company-fit now" })).toBeVisible();
  await expect(page.getByText("Run profitable Iron Bar")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Next feasible steps" })).toBeVisible();
  await expect(page.getByText("No affordable progression step cleared the current cash-risk gate.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Aspirational targets", exact: true })).toBeVisible();
  await expect(page.getByText("Restructure toward Tools", { exact: true })).toBeVisible();
  await expect(page.getByText("cash-stretch").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Blocked long-term references" })).toBeVisible();
  await expect(page.getByText("Restructure toward Uranium Ore", { exact: true })).toBeVisible();
  await expect(page.getByText("Known minimum").first()).toBeVisible();
  await expect(page.getByText("$1,195,000", { exact: true })).toBeVisible();
  await expect(page.getByText("New planet/base/resource access for Uranium Ore is not priced from the current snapshot.")).toBeVisible();
  await page.getByRole("button", { name: "Chains" }).click();
  await expect(page.getByText("Chain optimizer")).toBeVisible();
  await expect(page.getByText("Iron Bar -> Tools")).toBeVisible();
  await expect(page.getByText("Restructure toward Tools chain", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "What-if" }).click();
  await page.getByRole("button", { name: "Compare Scenario" }).click();
  await expect(page.getByRole("heading", { name: "Stage inputs for Tools" })).toBeVisible();
  await expect(page.getByText("Delta")).toBeVisible();
  await expect(page.getByText("Build or acquire Toolworks.").first()).toBeVisible();
});

test("full OpenAI model remains selectable", async ({ page }) => {
  await page.route("**/api/session/keys", async (route) => {
    await route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/session/models?provider=openai&refresh=false", async (route) => {
    await route.fulfill({
      json: {
        provider: "openai",
        defaultModel: "gpt-4.1-mini",
        models: [
          { id: "gpt-4.1-mini", label: "gpt-4.1-mini", source: "provider" },
          { id: "gpt-5", label: "gpt-5", source: "provider" }
        ],
        warnings: []
      }
    });
  });
  await page.route("**/api/agent/sitrep", async (route) => {
    const payload = route.request().postDataJSON();
    expect(payload.model).toBe("gpt-5");
    await route.fulfill({
      json: {
        generatedAt: new Date().toISOString(),
        provider: "openai",
        model: "gpt-5",
        summary: "Full model was selected explicitly.",
        operationsBrief: mockOperationsBrief(),
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

  await expect(page.getByLabel("Model")).toHaveValue("gpt-4.1-mini");
  await expect(page.getByText("Fast OpenAI models are selected by default.")).toBeVisible();
  await page.locator(".console-panel .control-grid select").nth(1).selectOption("gpt-5");
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
        defaultModel: "gpt-4.1-mini",
        models: [{ id: "gpt-4.1-mini", label: "gpt-4.1-mini", source: "provider" }],
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
        model: "gpt-4.1-mini",
        summary: "CV growth needs a prepared path, not a blind spend.",
        operationsBrief: mockOperationsBrief(),
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
        defaultModel: "gpt-4.1-mini",
        models: [
          { id: "gpt-4.1-mini", label: "gpt-4.1-mini", source: "provider" },
          { id: "gpt-5", label: "gpt-5", source: "provider" }
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
          model: "gpt-4.1-mini",
          summary: "Fast model generated the current dashboard.",
          operationsBrief: mockOperationsBrief(),
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
        details: { provider: "openai", model: "gpt-5", timeoutMs: 720000, timeout: "12m" }
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

  await page.locator(".console-panel .control-grid select").nth(1).selectOption("gpt-5");
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
        model: "gpt-4.1-mini",
        summary: "Fallback model still generated a sitrep.",
        operationsBrief: mockOperationsBrief(),
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
  await expect(page.getByLabel("Model")).toHaveValue("gpt-4.1-mini");
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
        defaultModel: "gpt-4.1-mini",
        models: [{ id: "gpt-4.1-mini", label: "gpt-4.1-mini", source: "provider" }],
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
        operationsBrief: mockOperationsBrief(),
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

  await expect(page.getByLabel("Model")).toHaveValue("gpt-4.1-mini");
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
        operationsBrief: mockOperationsBrief(),
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
