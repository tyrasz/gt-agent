import type {
  ActionPlan,
  ExpansionCandidate,
  GameSnapshot,
  LogisticsMove,
  MarketSignal,
  MaterialAmount,
  PlayerPlanningContext,
  PreparedCommand,
  Provider,
  SitrepResponse,
  StockoutRisk
} from "../shared/schemas.js";

type AnalysisResult = {
  marketSignals: MarketSignal[];
  stockoutRisks: StockoutRisk[];
  expansionCandidates: ExpansionCandidate[];
  logisticsMoves: LogisticsMove[];
  actionPlans: ActionPlan[];
  summary: string;
  warnings: string[];
};

type MaterialLookup = Map<number, { id: number; name: string; weight: number; cp?: number }>;

export function analyzeSnapshot(snapshot: GameSnapshot, context: PlayerPlanningContext): AnalysisResult {
  const materials = getMaterials(snapshot);
  const marketSignals = computeMarketSignals(snapshot, materials);
  const stockoutRisks = computeStockoutRisks(snapshot, materials, context);
  const logisticsMoves = computeLogisticsMoves(snapshot, materials, stockoutRisks);
  const expansionCandidates = computeExpansionCandidates(snapshot, materials, stockoutRisks);
  const actionPlans = buildActionPlans(marketSignals, stockoutRisks, logisticsMoves, expansionCandidates, context);
  const companyName = text(snapshot.company.name) || "your company";
  const summary = `${companyName} has ${actionPlans.filter((plan) => plan.priority === "critical" || plan.priority === "high").length} high-priority moves for the next ${context.autonomyHours} hours, led by ${actionPlans[0]?.title ?? "market monitoring"}.`;

  return {
    marketSignals,
    stockoutRisks,
    logisticsMoves,
    expansionCandidates,
    actionPlans,
    summary,
    warnings: snapshot.warnings
  };
}

export function buildDeterministicSitrep(
  snapshot: GameSnapshot,
  context: PlayerPlanningContext,
  provider: Provider,
  model: string,
  extraWarnings: string[] = []
): SitrepResponse {
  const analysis = analyzeSnapshot(snapshot, context);
  return {
    generatedAt: new Date().toISOString(),
    provider,
    model,
    summary: analysis.summary,
    actionPlans: analysis.actionPlans,
    marketSignals: analysis.marketSignals,
    stockoutRisks: analysis.stockoutRisks,
    expansionCandidates: analysis.expansionCandidates,
    logisticsMoves: analysis.logisticsMoves,
    warnings: [...analysis.warnings, ...extraWarnings],
    rawSnapshot: snapshot
  };
}

function computeMarketSignals(snapshot: GameSnapshot, materials: MaterialLookup): MarketSignal[] {
  const recipeMargins = computeRecipeMargins(snapshot, materials);
  const details = snapshot.market.details.length > 0 ? snapshot.market.details : snapshot.market.prices;

  return details
    .map((item) => {
      const matId = numberValue(item.matId) ?? numberValue(item.id) ?? 0;
      const mat = materials.get(matId);
      const matName = text(item.matName) || mat?.name || `Material ${matId}`;
      const currentPrice = numberValue(item.currentPrice) ?? -1;
      const avgPrice = numberValue(item.avgPrice) ?? -1;
      const totalQtyAvailable = numberValue(item.totalQtyAvailable);
      const avgQtySoldDaily = numberValue(item.avgQtySoldDaily);
      const history = Array.isArray(item.priceHistory) ? item.priceHistory.filter(isRecord) : [];
      const trend = priceTrend(history);
      const volatilityPct = priceVolatility(history);
      const spreadPct = currentPrice > 0 && avgPrice > 0 ? ((currentPrice - avgPrice) / avgPrice) * 100 : 0;
      const recipeMarginPct = recipeMargins.get(matId);
      const recommendation = marketRecommendation(currentPrice, avgPrice, spreadPct, totalQtyAvailable, avgQtySoldDaily, recipeMarginPct);
      const rationale = [
        currentPrice > 0 && avgPrice > 0 ? `${formatMoney(currentPrice)} current vs ${formatMoney(avgPrice)} recent average (${formatPct(spreadPct)}).` : "No reliable current/average price pair is available.",
        avgQtySoldDaily !== undefined ? `${Math.round(avgQtySoldDaily).toLocaleString()} avg units sold daily.` : "No daily sales velocity was reported.",
        recipeMarginPct !== undefined ? `Best recipe margin estimate is ${formatPct(recipeMarginPct)} before logistics/time costs.` : "No direct recipe margin estimate was available."
      ];

      return {
        matId,
        matName,
        currentPrice,
        avgPrice,
        spreadPct: round(spreadPct),
        totalQtyAvailable,
        avgQtySoldDaily,
        trend,
        volatilityPct,
        recipeMarginPct,
        recommendation,
        rationale
      } satisfies MarketSignal;
    })
    .filter((signal) => signal.matId > 0)
    .sort((a, b) => signalScore(b) - signalScore(a))
    .slice(0, 24);
}

function computeStockoutRisks(snapshot: GameSnapshot, materials: MaterialLookup, context: PlayerPlanningContext): StockoutRisk[] {
  const inventory = aggregateInventory(snapshot.warehouses);
  const requirements = aggregateRequirements(snapshot, context);

  return Array.from(requirements.entries())
    .map(([matId, required]) => {
      const availableQty = inventory.get(matId)?.quantity ?? 0;
      const shortageQty = Math.max(0, required.quantity - availableQty);
      const severity = shortageSeverity(shortageQty, required.quantity, context.autonomyHours);
      return {
        matId,
        matName: materials.get(matId)?.name ?? required.matName ?? `Material ${matId}`,
        availableQty: round(availableQty),
        requiredQty: round(required.quantity),
        shortageQty: round(shortageQty),
        hoursUntilStockout: shortageQty > 0 ? Math.max(0, round((availableQty / Math.max(required.quantity, 1)) * context.autonomyHours)) : undefined,
        severity,
        affectedBases: [...required.affectedBases]
      } satisfies StockoutRisk;
    })
    .filter((risk) => risk.shortageQty > 0 || risk.severity !== "low")
    .sort((a, b) => severityScore(b.severity) - severityScore(a.severity) || b.shortageQty - a.shortageQty)
    .slice(0, 20);
}

function computeLogisticsMoves(snapshot: GameSnapshot, materials: MaterialLookup, risks: StockoutRisk[]): LogisticsMove[] {
  const warehouses = snapshot.warehouses;
  const exchangeWarehouse = warehouses.find((warehouse) => numberValue(warehouse.type) === 3);
  const shipWarehouses = warehouses.filter((warehouse) => numberValue(warehouse.type) === 2);
  const baseWarehouses = warehouses.filter((warehouse) => numberValue(warehouse.type) === 1);
  const moves: LogisticsMove[] = [];

  for (const risk of risks.slice(0, 10)) {
    const source = findWarehouseWithMaterial([exchangeWarehouse, ...shipWarehouses, ...baseWarehouses], risk.matId, risk.shortageQty);
    if (!source) continue;
    const sourceName = warehouseName(snapshot, source);
    const targetName = risk.affectedBases[0] ?? "highest-priority base";
    const quantity = Math.min(risk.shortageQty, source.quantity);
    const material = materials.get(risk.matId);
    const tonnes = quantity * (material?.weight ?? 1);
    moves.push({
      from: sourceName,
      to: targetName,
      matId: risk.matId,
      materialName: risk.matName,
      quantity: round(quantity),
      tonnes: round(tonnes),
      shipName: shipWarehouses.length > 0 ? text(shipWarehouses[0].name) || `Ship warehouse ${shipWarehouses[0].id}` : undefined,
      reason: `${targetName} is short ${Math.round(risk.shortageQty).toLocaleString()} ${risk.matName}.`,
      steps: [
        `Load ${Math.round(quantity).toLocaleString()} ${risk.matName} at ${sourceName}.`,
        `Route a cargo ship to ${targetName}.`,
        `Unload into the destination warehouse before restarting dependent production.`
      ]
    });
  }

  return moves;
}

function computeExpansionCandidates(snapshot: GameSnapshot, materials: MaterialLookup, risks: StockoutRisk[]): ExpansionCandidate[] {
  const candidates: ExpansionCandidate[] = [];
  const cash = numberValue(snapshot.company.cash) ?? 0;
  const bases = snapshot.bases;
  const basePlans = snapshot.basePlans;

  for (const base of bases) {
    const baseName = text(base.name) || `Base ${numberValue(base.id) ?? "?"}`;
    const slots = numberValue(base.buildingSlots);
    const productionOrders = Array.isArray(base.productionOrders) ? base.productionOrders.length : 0;
    if (slots !== undefined && productionOrders >= Math.max(1, slots - 1)) {
      candidates.push({
        title: `Relieve ${baseName} production slot pressure`,
        type: "building",
        priority: "medium",
        estimatedCost: undefined,
        requiredMaterials: risks.slice(0, 3).map((risk) => materialAmountFromRisk(risk, materials)),
        blockers: risks.slice(0, 3).map((risk) => `${risk.matName}: ${Math.round(risk.shortageQty).toLocaleString()} short`),
        rationale: [`${baseName} appears close to its usable production/building capacity.`],
        preparedCommands: [reviewCommand(`Review ${baseName} build queue`, { baseId: base.id })]
      });
    }
  }

  if (basePlans.length > 0) {
    for (const plan of basePlans.slice(0, 4)) {
      const title = text(plan.title) || `Planet ${numberValue(plan.id) ?? "base"} plan`;
      candidates.push({
        title: `Audit ${title}`,
        type: "base_plan",
        priority: cash > 2_500_000 ? "high" : "medium",
        requiredMaterials: risks.slice(0, 5).map((risk) => materialAmountFromRisk(risk, materials)),
        blockers: cash <= 0 ? ["Cash balance was unavailable or zero in the API snapshot."] : [],
        rationale: [`Base plan exists and should be checked against current market prices before committing materials.`],
        preparedCommands: [reviewCommand(`Open ${title} base plan`, { planId: plan.id })]
      });
    }
  }

  const warehousePressure = snapshot.warehouses
    .map((warehouse) => ({ warehouse, utilization: warehouseUtilization(warehouse, materials) }))
    .filter((item) => item.utilization > 0.85)
    .sort((a, b) => b.utilization - a.utilization);

  for (const item of warehousePressure.slice(0, 3)) {
    candidates.push({
      title: `Increase capacity for ${warehouseName(snapshot, item.warehouse)}`,
      type: "warehouse",
      priority: item.utilization > 0.95 ? "high" : "medium",
      requiredMaterials: [],
      blockers: [],
      rationale: [`Warehouse utilization is approximately ${formatPct(item.utilization * 100)}.`],
      preparedCommands: [reviewCommand("Review warehouse capacity project", { warehouseId: item.warehouse.id })]
    });
  }

  if (candidates.length === 0) {
    candidates.push({
      title: "Keep expansion optional until bottlenecks surface",
      type: "base_plan",
      priority: "low",
      requiredMaterials: [],
      blockers: [],
      rationale: ["No severe capacity or base-plan bottleneck was visible in the current read-only snapshot."],
      preparedCommands: [reviewCommand("Review long-range expansion choices", {})]
    });
  }

  return candidates.slice(0, 10);
}

function buildActionPlans(
  marketSignals: MarketSignal[],
  stockoutRisks: StockoutRisk[],
  logisticsMoves: LogisticsMove[],
  expansionCandidates: ExpansionCandidate[],
  context: PlayerPlanningContext
): ActionPlan[] {
  const plans: ActionPlan[] = [];

  for (const risk of stockoutRisks.slice(0, 5)) {
    const command: PreparedCommand = {
      type: "buy_material",
      title: `Restock ${risk.matName}`,
      executable: false,
      payload: { matId: risk.matId, quantity: Math.ceil(risk.shortageQty) },
      steps: [
        `Buy or produce ${Math.ceil(risk.shortageQty).toLocaleString()} ${risk.matName}.`,
        "Move the material from the Exchange warehouse to the affected base.",
        "Restart or extend the blocked production queue."
      ]
    };
    plans.push({
      id: `restock-${risk.matId}`,
      title: `Restock ${risk.matName}`,
      priority: risk.severity,
      category: "operations",
      expectedBenefit: `Protects the next ${context.autonomyHours} hours of operations.`,
      costSummary: `${Math.ceil(risk.shortageQty).toLocaleString()} units required.`,
      risk: risk.severity === "critical" ? "Production interruption is likely before the next check-in." : "Delay may reduce throughput.",
      evidence: [`${risk.availableQty.toLocaleString()} available vs ${risk.requiredQty.toLocaleString()} required.`, ...risk.affectedBases],
      preparedCommands: [command]
    });
  }

  for (const move of logisticsMoves.slice(0, 4)) {
    plans.push({
      id: `move-${move.matId}-${plans.length}`,
      title: `Move ${move.materialName} to ${move.to}`,
      priority: "high",
      category: "logistics",
      expectedBenefit: "Clears an inventory placement bottleneck.",
      costSummary: `${Math.ceil(move.tonnes).toLocaleString()} tonnes of cargo capacity.`,
      risk: "Ship timing and current location must be checked in-game before dispatch.",
      evidence: [move.reason],
      preparedCommands: [
        {
          type: "move_cargo",
          title: `Transfer ${move.materialName}`,
          executable: false,
          payload: move,
          steps: move.steps
        }
      ]
    });
  }

  for (const signal of marketSignals.filter((item) => item.recommendation === "buy" || item.recommendation === "sell").slice(0, 6)) {
    plans.push({
      id: `market-${signal.matId}`,
      title: `${signal.recommendation === "buy" ? "Buy" : "Reprice"} ${signal.matName}`,
      priority: Math.abs(signal.spreadPct) > 25 ? "high" : "medium",
      category: "market",
      expectedBenefit: signal.recommendation === "buy" ? "Captures below-average input pricing." : "Captures above-average market pricing.",
      costSummary: `${formatMoney(signal.currentPrice)} current, ${formatPct(signal.spreadPct)} vs average.`,
      risk: "Market price and order depth can change before manual execution.",
      evidence: signal.rationale,
      preparedCommands: [
        {
          type: signal.recommendation === "buy" ? "buy_material" : "adjust_sell_offer",
          title: `${signal.recommendation === "buy" ? "Check buy quantity for" : "Review sell offer for"} ${signal.matName}`,
          executable: false,
          payload: { matId: signal.matId, currentPrice: signal.currentPrice, avgPrice: signal.avgPrice },
          steps: [
            `Open ${signal.matName} on the Galactic Exchange.`,
            "Compare the visible cheapest orders against this snapshot.",
            signal.recommendation === "buy" ? "Buy only enough to cover near-term production." : "Adjust your offer near the current competitive range."
          ]
        }
      ]
    });
  }

  for (const candidate of expansionCandidates.slice(0, 3)) {
    plans.push({
      id: `expand-${candidate.type}-${plans.length}`,
      title: candidate.title,
      priority: candidate.priority,
      category: "expansion",
      expectedBenefit: "Reduces the next structural bottleneck.",
      costSummary: candidate.requiredMaterials.length > 0 ? `${candidate.requiredMaterials.length} material groups to validate.` : "No material estimate in read-only snapshot.",
      risk: candidate.blockers.length > 0 ? candidate.blockers.join(" ") : "Expansion can trap cash if started before inputs are secured.",
      evidence: candidate.rationale,
      preparedCommands: candidate.preparedCommands
    });
  }

  return plans.sort((a, b) => severityScore(b.priority) - severityScore(a.priority)).slice(0, 16);
}

function getMaterials(snapshot: GameSnapshot): MaterialLookup {
  const raw = Array.isArray(snapshot.gameData.materials) ? snapshot.gameData.materials.filter(isRecord) : [];
  return new Map(
    raw
      .map((item) => {
        const id = numberValue(item.id) ?? 0;
        return [
          id,
          {
            id,
            name: text(item.name) || text(item.sName) || `Material ${id}`,
            weight: numberValue(item.weight) ?? 1,
            cp: numberValue(item.cp)
          }
        ] as const;
      })
      .filter(([id]) => id > 0)
  );
}

function computeRecipeMargins(snapshot: GameSnapshot, materials: MaterialLookup): Map<number, number> {
  const prices = new Map<number, number>();
  for (const item of snapshot.market.prices) {
    const matId = numberValue(item.matId) ?? numberValue(item.id);
    const price = numberValue(item.currentPrice);
    if (matId && price && price > 0) prices.set(matId, price);
  }

  const recipes = Array.isArray(snapshot.gameData.recipes) ? snapshot.gameData.recipes.filter(isRecord) : [];
  const best = new Map<number, number>();
  for (const recipe of recipes) {
    const output = isRecord(recipe.output) ? recipe.output : undefined;
    const outputId = output ? numberValue(output.id) ?? numberValue(output.i) : undefined;
    const outputAmount = output ? numberValue(output.am) ?? numberValue(output.a) ?? 1 : 1;
    if (!outputId) continue;
    const outputPrice = prices.get(outputId) ?? materials.get(outputId)?.cp;
    if (!outputPrice) continue;
    const inputCost = Array.isArray(recipe.inputs)
      ? recipe.inputs.filter(isRecord).reduce((sum, input) => {
          const inputId = numberValue(input.id) ?? numberValue(input.i);
          const amount = numberValue(input.am) ?? numberValue(input.a) ?? 0;
          const price = inputId ? prices.get(inputId) ?? materials.get(inputId)?.cp ?? 0 : 0;
          return sum + price * amount;
        }, 0)
      : 0;
    if (inputCost <= 0) continue;
    const revenue = outputPrice * outputAmount;
    const margin = ((revenue - inputCost) / inputCost) * 100;
    best.set(outputId, Math.max(best.get(outputId) ?? -Infinity, round(margin)));
  }
  return best;
}

function aggregateInventory(warehouses: Record<string, unknown>[]): Map<number, { quantity: number; locations: Set<string> }> {
  const inventory = new Map<number, { quantity: number; locations: Set<string> }>();
  for (const warehouse of warehouses) {
    const mats = Array.isArray(warehouse.mats) ? warehouse.mats.filter(isRecord) : [];
    for (const mat of mats) {
      const matId = numberValue(mat.matId) ?? numberValue(mat.id) ?? numberValue(mat.i);
      const quantity = numberValue(mat.qty) ?? numberValue(mat.quantity) ?? numberValue(mat.am) ?? numberValue(mat.a) ?? 0;
      if (!matId || quantity <= 0) continue;
      const entry = inventory.get(matId) ?? { quantity: 0, locations: new Set<string>() };
      entry.quantity += quantity;
      entry.locations.add(text(warehouse.name) || `Warehouse ${numberValue(warehouse.id) ?? "?"}`);
      inventory.set(matId, entry);
    }
  }
  return inventory;
}

function aggregateRequirements(snapshot: GameSnapshot, context: PlayerPlanningContext): Map<number, { quantity: number; matName?: string; affectedBases: Set<string> }> {
  const requirements = new Map<number, { quantity: number; matName?: string; affectedBases: Set<string> }>();

  for (const wishlist of snapshot.wishlists) {
    const title = text(wishlist.title) || `Wishlist ${numberValue(wishlist.id) ?? "?"}`;
    const mats = Array.isArray(wishlist.mats) ? wishlist.mats.filter(isRecord) : [];
    for (const mat of mats) {
      addRequirement(requirements, mat, title, 1);
    }
  }

  const recipesById = new Map<number, Record<string, unknown>>();
  const recipes = Array.isArray(snapshot.gameData.recipes) ? snapshot.gameData.recipes.filter(isRecord) : [];
  for (const recipe of recipes) {
    const id = numberValue(recipe.id);
    if (id) recipesById.set(id, recipe);
  }

  const planningMultiplier = Math.max(1, Math.ceil(context.autonomyHours / 12));
  for (const base of snapshot.bases) {
    const baseName = text(base.name) || `Base ${numberValue(base.id) ?? "?"}`;
    const orders = Array.isArray(base.productionOrders) ? base.productionOrders.filter(isRecord) : [];
    for (const order of orders) {
      const nestedRecipe = isRecord(order.recipe) ? order.recipe : undefined;
      const recipeId = numberValue(order.recipeId) ?? numberValue(order.rId) ?? numberValue(nestedRecipe?.id);
      const recipe = recipeId ? recipesById.get(recipeId) : undefined;
      const inputs = recipe && Array.isArray(recipe.inputs) ? recipe.inputs.filter(isRecord) : [];
      for (const input of inputs) {
        addRequirement(requirements, input, baseName, planningMultiplier);
      }
    }
  }

  return requirements;
}

function addRequirement(
  requirements: Map<number, { quantity: number; matName?: string; affectedBases: Set<string> }>,
  mat: Record<string, unknown>,
  affectedBase: string,
  multiplier: number
): void {
  const matId = numberValue(mat.matId) ?? numberValue(mat.id) ?? numberValue(mat.i);
  const quantity = (numberValue(mat.qty) ?? numberValue(mat.quantity) ?? numberValue(mat.am) ?? numberValue(mat.a) ?? 0) * multiplier;
  if (!matId || quantity <= 0) return;
  const entry = requirements.get(matId) ?? { quantity: 0, matName: text(mat.matName) || text(mat.name), affectedBases: new Set<string>() };
  entry.quantity += quantity;
  entry.affectedBases.add(affectedBase);
  requirements.set(matId, entry);
}

function findWarehouseWithMaterial(
  warehouses: Array<Record<string, unknown> | undefined>,
  matId: number,
  needed: number
): (Record<string, unknown> & { quantity: number }) | undefined {
  const matches = warehouses
    .filter((warehouse): warehouse is Record<string, unknown> => Boolean(warehouse))
    .map((warehouse) => {
      const mats = Array.isArray(warehouse.mats) ? warehouse.mats.filter(isRecord) : [];
      const quantity = mats.reduce((sum, mat) => {
        const id = numberValue(mat.matId) ?? numberValue(mat.id) ?? numberValue(mat.i);
        if (id !== matId) return sum;
        return sum + (numberValue(mat.qty) ?? numberValue(mat.quantity) ?? numberValue(mat.am) ?? numberValue(mat.a) ?? 0);
      }, 0);
      return { ...warehouse, quantity };
    })
    .filter((warehouse) => warehouse.quantity > 0)
    .sort((a, b) => {
      const enoughDiff = Number(b.quantity >= needed) - Number(a.quantity >= needed);
      return enoughDiff || b.quantity - a.quantity;
    });

  return matches[0];
}

function warehouseName(snapshot: GameSnapshot, warehouse: Record<string, unknown>): string {
  const type = numberValue(warehouse.type);
  const holderId = numberValue(warehouse.holderId);
  if (type === 3) return "Exchange warehouse";
  if (type === 2) return text(warehouse.name) || `Ship warehouse ${holderId ?? numberValue(warehouse.id) ?? "?"}`;
  if (type === 1) {
    const base = snapshot.bases.find((item) => numberValue(item.id) === holderId || numberValue(item.warehouseId) === numberValue(warehouse.id));
    return text(base?.name) || `Base warehouse ${holderId ?? numberValue(warehouse.id) ?? "?"}`;
  }
  return text(warehouse.name) || `Warehouse ${numberValue(warehouse.id) ?? "?"}`;
}

function warehouseUtilization(warehouse: Record<string, unknown>, materials: MaterialLookup): number {
  const cap = numberValue(warehouse.cap);
  if (!cap || cap <= 0) return 0;
  const mats = Array.isArray(warehouse.mats) ? warehouse.mats.filter(isRecord) : [];
  const tonnes = mats.reduce((sum, mat) => {
    const matId = numberValue(mat.matId) ?? numberValue(mat.id) ?? numberValue(mat.i);
    const quantity = numberValue(mat.qty) ?? numberValue(mat.quantity) ?? numberValue(mat.am) ?? numberValue(mat.a) ?? 0;
    return sum + quantity * (matId ? materials.get(matId)?.weight ?? 1 : 1);
  }, 0);
  return tonnes / cap;
}

function marketRecommendation(
  currentPrice: number,
  avgPrice: number,
  spreadPct: number,
  totalQtyAvailable?: number,
  avgQtySoldDaily?: number,
  recipeMarginPct?: number
): MarketSignal["recommendation"] {
  if (currentPrice <= 0 || avgPrice <= 0) return "avoid";
  if (spreadPct <= -15 && (avgQtySoldDaily ?? 0) > 0) return "buy";
  if (spreadPct >= 20) return "sell";
  if ((totalQtyAvailable ?? Infinity) < (avgQtySoldDaily ?? 0) * 1.5) return "restock";
  if ((recipeMarginPct ?? 0) >= 25) return "watch";
  return "watch";
}

function signalScore(signal: MarketSignal): number {
  return Math.abs(signal.spreadPct) + (signal.avgQtySoldDaily ?? 0) / 100 + Math.max(0, signal.recipeMarginPct ?? 0);
}

function priceTrend(history: Record<string, unknown>[]): MarketSignal["trend"] {
  const prices = history.map((item) => numberValue(item.avgPrice)).filter((value): value is number => Boolean(value && value > 0));
  if (prices.length < 2) return "unknown";
  const newest = prices[0];
  const oldest = prices[prices.length - 1];
  const change = ((newest - oldest) / oldest) * 100;
  if (change > 5) return "up";
  if (change < -5) return "down";
  return "flat";
}

function priceVolatility(history: Record<string, unknown>[]): number | undefined {
  const prices = history.map((item) => numberValue(item.avgPrice)).filter((value): value is number => Boolean(value && value > 0));
  if (prices.length < 2) return undefined;
  const mean = prices.reduce((sum, value) => sum + value, 0) / prices.length;
  const variance = prices.reduce((sum, value) => sum + (value - mean) ** 2, 0) / prices.length;
  return round((Math.sqrt(variance) / mean) * 100);
}

function shortageSeverity(shortageQty: number, requiredQty: number, autonomyHours: number): StockoutRisk["severity"] {
  if (shortageQty <= 0) return "low";
  const ratio = shortageQty / Math.max(requiredQty, 1);
  if (ratio >= 0.75 || autonomyHours <= 4) return "critical";
  if (ratio >= 0.4) return "high";
  if (ratio >= 0.15) return "medium";
  return "low";
}

function severityScore(priority: ActionPlan["priority"] | StockoutRisk["severity"] | ExpansionCandidate["priority"]): number {
  return { low: 1, medium: 2, high: 3, critical: 4 }[priority];
}

function materialAmountFromRisk(risk: StockoutRisk, materials: MaterialLookup): MaterialAmount {
  return {
    matId: risk.matId,
    matName: risk.matName,
    quantity: risk.shortageQty,
    tonnes: risk.shortageQty * (materials.get(risk.matId)?.weight ?? 1)
  };
}

function reviewCommand(title: string, payload: Record<string, unknown>): PreparedCommand {
  return {
    type: "review",
    title,
    executable: false,
    payload,
    steps: ["Open the relevant in-game screen.", "Compare current game state against this snapshot.", "Apply only the manual changes that still match current conditions."]
  };
}

function formatMoney(cents: number): string {
  if (cents < 0) return "n/a";
  return `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function formatPct(value: number): string {
  return `${round(value)}%`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
