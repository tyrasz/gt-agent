import type { GameSnapshot } from "../../shared/schemas.js";

export function makeSnapshot(): GameSnapshot {
  return {
    fetchedAt: "2026-05-16T12:00:00.000Z",
    company: {
      id: 42,
      name: "Stellar Foundry",
      cash: 5_000_000,
      rank: 21,
      value: 20_000_000,
      poSlots: 8,
      shipSlots: 3
    },
    bases: [
      {
        id: 1,
        name: "Forge Prime",
        planetId: 101,
        warehouseId: 11,
        buildingSlots: 4,
        productionOrders: [{ recipeId: 1001 }]
      }
    ],
    warehouses: [
      {
        id: 11,
        type: 1,
        holderId: 1,
        cap: 500,
        mats: [{ id: 1, qty: 20 }]
      },
      {
        id: 99,
        type: 3,
        holderId: 0,
        cap: 1000,
        mats: [{ id: 2, qty: 500 }]
      }
    ],
    exchangeOrders: [],
    cashHistory: [],
    contracts: [],
    basePlans: [{ id: 101, title: "Forge Prime Expansion", exp: 2, slots: [] }],
    wishlists: [{ id: 101, title: "Forge Prime", mats: [{ id: 2, qty: 200 }] }],
    market: {
      prices: [
        { matId: 1, matName: "Iron Ore", currentPrice: 4000, avgPrice: 5000 },
        { matId: 2, matName: "Iron Bar", currentPrice: 12000, avgPrice: 9000 }
      ],
      details: [
        {
          matId: 1,
          matName: "Iron Ore",
          currentPrice: 4000,
          avgPrice: 5000,
          totalQtyAvailable: 10000,
          avgQtySoldDaily: 800,
          priceHistory: [
            { date: "2026-05-16", avgPrice: 4000, qtySold: 800, qtyRemaining: 10000 },
            { date: "2026-05-15", avgPrice: 5000, qtySold: 900, qtyRemaining: 9000 }
          ]
        },
        {
          matId: 2,
          matName: "Iron Bar",
          currentPrice: 12000,
          avgPrice: 9000,
          totalQtyAvailable: 3000,
          avgQtySoldDaily: 1000,
          priceHistory: [
            { date: "2026-05-16", avgPrice: 12000, qtySold: 600, qtyRemaining: 200 },
            { date: "2026-05-15", avgPrice: 9000, qtySold: 500, qtyRemaining: 500 }
          ]
        }
      ]
    },
    gameData: {
      materials: [
        { id: 1, name: "Iron Ore", weight: 1, cp: 4500 },
        { id: 2, name: "Iron Bar", weight: 2, cp: 8000 },
        { id: 3, name: "Tools", weight: 1, cp: 6000 }
      ],
      recipes: [
        {
          id: 1001,
          producedIn: 10,
          timeMinutes: 60,
          inputs: [{ id: 1, am: 100 }],
          output: { id: 2, am: 50 }
        },
        {
          id: 2001,
          producedIn: 20,
          timeMinutes: 60,
          inputs: [{ id: 2, am: 10 }],
          output: { id: 3, am: 100 }
        }
      ],
      buildings: [
        {
          id: 10,
          name: "Smelter",
          specialization: 5,
          tier: 1,
          requiredResearch: 0,
          recipesIds: [1001],
          workersNeeded: [10, 0, 0, 0],
          constructionMaterials: [{ id: 1, am: 50 }],
          cost: 100_000
        },
        {
          id: 20,
          name: "Toolworks",
          specialization: 2,
          tier: 2,
          requiredResearch: 4,
          recipesIds: [2001],
          workersNeeded: [20, 5, 0, 0],
          constructionMaterials: [{ id: 2, am: 100 }],
          cost: 700_000
        }
      ],
      workers: [
        { type: 1, name: "Workers", consumables: [] },
        { type: 2, name: "Technicians", consumables: [] }
      ]
    },
    rateLimits: [],
    warnings: []
  };
}

export function makeProviderJson(overrides: Record<string, unknown> = {}) {
  return {
    summary: "Prioritize restocking and market repricing.",
    decisionBriefNarrative: {},
    actionPlanNarratives: [],
    warnings: [],
    ...overrides
  };
}
