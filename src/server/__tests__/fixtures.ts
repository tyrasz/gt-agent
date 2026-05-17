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
          totalQtyAvailable: 200,
          avgQtySoldDaily: 600,
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
        { id: 2, name: "Iron Bar", weight: 2, cp: 8000 }
      ],
      recipes: [
        {
          id: 1001,
          inputs: [{ id: 1, am: 100 }],
          output: { id: 2, am: 50 }
        }
      ]
    },
    rateLimits: [],
    warnings: []
  };
}

export function makeProviderJson(overrides: Record<string, unknown> = {}) {
  return {
    summary: "Prioritize restocking and market repricing.",
    actionPlanNarratives: [],
    warnings: [],
    ...overrides
  };
}
