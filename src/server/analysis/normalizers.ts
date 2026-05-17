import type { GameSnapshot, PlayerPlanningContext } from "../../shared/schemas.js";
import { numberValue, recordArray, round, text } from "./utils.js";

export type WarehouseKind = "base" | "ship" | "exchange" | "other";

export type MaterialInfo = {
  id: number;
  name: string;
  weight: number;
  cp?: number;
  inputFor: number[];
  outputFrom: number[];
};

export type MaterialCatalog = Map<number, MaterialInfo>;

export type BuildingInfo = {
  id: number;
  name: string;
  industry?: string;
  tier?: number;
  requiredResearch?: number;
  recipesIds: number[];
  workersNeeded: number[];
  constructionMaterials: Array<{ matId: number; quantity: number }>;
  cost?: number;
};

export type BuildingCatalog = Map<number, BuildingInfo>;

export type InventoryLocation = {
  warehouseId?: number;
  warehouseName: string;
  warehouseType: WarehouseKind;
  holderId?: number;
  quantity: number;
  tonnes: number;
};

export type InventoryPosition = {
  matId: number;
  matName: string;
  totalQty: number;
  totalTonnes: number;
  baseQty: number;
  shipQty: number;
  exchangeQty: number;
  locations: InventoryLocation[];
};

export type DemandPosition = {
  matId: number;
  matName: string;
  requiredQty: number;
  wishlistQty: number;
  productionQtyPer12h: number;
  affectedBases: string[];
  reasons: string[];
  planningHorizonHours: number;
};

export type WarehousePosition = {
  id?: number;
  name: string;
  type: WarehouseKind;
  holderId?: number;
  cap?: number;
  usedTonnes: number;
  utilization: number;
  freeTonnes?: number;
};

export type NormalizedSnapshot = {
  companyName: string;
  materials: MaterialCatalog;
  buildings: BuildingCatalog;
  ownedBuildingIds: Set<number>;
  activeRecipeIds: Set<number>;
  inventory: Map<number, InventoryPosition>;
  demand: Map<number, DemandPosition>;
  warehouses: WarehousePosition[];
  bases: Record<string, unknown>[];
  exchangeOrders: Record<string, unknown>[];
  basePlans: Record<string, unknown>[];
  cash: number;
  cashTrendPct?: number;
  warnings: string[];
};

export function normalizeSnapshot(snapshot: GameSnapshot, context: PlayerPlanningContext): NormalizedSnapshot {
  const materials = buildMaterialCatalog(snapshot);
  const buildings = buildBuildingCatalog(snapshot);
  const warehouses = buildWarehousePositions(snapshot, materials);
  const activeRecipeIds = buildActiveRecipeIds(snapshot);
  return {
    companyName: text(snapshot.company.name) || "your company",
    materials,
    buildings,
    ownedBuildingIds: buildOwnedBuildingIds(snapshot, buildings, activeRecipeIds),
    activeRecipeIds,
    warehouses,
    inventory: buildInventoryPositions(snapshot, materials),
    demand: buildDemandPositions(snapshot, context, materials),
    bases: snapshot.bases,
    exchangeOrders: snapshot.exchangeOrders,
    basePlans: snapshot.basePlans,
    cash: numberValue(snapshot.company.cash) ?? 0,
    cashTrendPct: computeCashTrendPct(snapshot.cashHistory),
    warnings: snapshot.warnings
  };
}

function buildMaterialCatalog(snapshot: GameSnapshot): MaterialCatalog {
  const materials = new Map<number, MaterialInfo>();
  for (const item of recordArray(snapshot.gameData.materials)) {
    const id = numberValue(item.id) ?? 0;
    if (!id) continue;
    materials.set(id, {
      id,
      name: text(item.name) || text(item.sName) || `Material ${id}`,
      weight: numberValue(item.weight) ?? 1,
      cp: numberValue(item.cp),
      inputFor: [],
      outputFrom: []
    });
  }

  for (const recipe of recordArray(snapshot.gameData.recipes)) {
    const recipeId = numberValue(recipe.id);
    const output = recordValue(recipe.output);
    const outputId = output ? numberValue(output.id) ?? numberValue(output.i) : undefined;
    if (recipeId && outputId) {
      const mat = materials.get(outputId);
      if (mat) mat.outputFrom.push(recipeId);
    }
    for (const input of recordArray(recipe.inputs)) {
      const inputId = numberValue(input.id) ?? numberValue(input.i);
      if (!recipeId || !inputId) continue;
      const mat = materials.get(inputId);
      if (mat) mat.inputFor.push(recipeId);
    }
  }

  return materials;
}

function buildBuildingCatalog(snapshot: GameSnapshot): BuildingCatalog {
  const buildings = new Map<number, BuildingInfo>();
  for (const item of recordArray(snapshot.gameData.buildings)) {
    const id = numberValue(item.id) ?? 0;
    if (!id) continue;
    const recipesIds = (Array.isArray(item.recipesIds) ? item.recipesIds : [])
      .map((recipe) => numberValue(recipe))
      .filter((recipeId): recipeId is number => Boolean(recipeId));
    const workersNeeded = Array.isArray(item.workersNeeded)
      ? item.workersNeeded.map((worker) => numberValue(worker) ?? 0)
      : [];
    const constructionMaterials = recordArray(item.constructionMaterials)
      .map((mat) => ({ matId: materialId(mat) ?? 0, quantity: materialQuantity(mat) }))
      .filter((mat) => mat.matId > 0 && mat.quantity > 0);
    buildings.set(id, {
      id,
      name: text(item.name) || `Building ${id}`,
      industry: industryName(numberValue(item.specialization)),
      tier: numberValue(item.tier),
      requiredResearch: numberValue(item.requiredResearch) ?? numberValue(item.reqTech),
      recipesIds,
      workersNeeded,
      constructionMaterials,
      cost: numberValue(item.cost)
    });
  }
  return buildings;
}

function buildActiveRecipeIds(snapshot: GameSnapshot): Set<number> {
  const ids = new Set<number>();
  for (const base of snapshot.bases) {
    for (const order of recordArray(base.productionOrders)) {
      const nestedRecipe = recordValue(order.recipe);
      const recipeId = numberValue(order.recipeId) ?? numberValue(order.rId) ?? numberValue(nestedRecipe?.id);
      if (recipeId) ids.add(recipeId);
    }
  }
  return ids;
}

function buildOwnedBuildingIds(snapshot: GameSnapshot, buildings: BuildingCatalog, activeRecipeIds: Set<number>): Set<number> {
  const ids = new Set<number>();

  for (const recipeId of activeRecipeIds) {
    for (const building of buildings.values()) {
      if (building.recipesIds.includes(recipeId)) ids.add(building.id);
    }
  }

  for (const base of snapshot.bases) {
    for (const candidate of [
      ...recordArray(base.buildings),
      ...recordArray(base.slots),
      ...recordArray(base.buildingSlots),
      ...recordArray(base.facilities)
    ]) {
      const nested = recordValue(candidate.building);
      const id = numberValue(candidate.buildingId) ?? numberValue(candidate.bId) ?? numberValue(candidate.typeId) ?? numberValue(nested?.id);
      if (id && buildings.has(id)) ids.add(id);
    }
  }

  return ids;
}

function buildInventoryPositions(snapshot: GameSnapshot, materials: MaterialCatalog): Map<number, InventoryPosition> {
  const inventory = new Map<number, InventoryPosition>();
  for (const warehouse of snapshot.warehouses) {
    const kind = warehouseKind(warehouse);
    const warehouseId = numberValue(warehouse.id);
    const holderId = numberValue(warehouse.holderId);
    const name = warehouseName(snapshot, warehouse);
    for (const mat of recordArray(warehouse.mats)) {
      const matId = materialId(mat);
      const quantity = materialQuantity(mat);
      if (!matId || quantity <= 0) continue;
      const material = materials.get(matId);
      const tonnes = quantity * (material?.weight ?? 1);
      const position = inventory.get(matId) ?? {
        matId,
        matName: material?.name ?? text(mat.matName) ?? text(mat.name) ?? `Material ${matId}`,
        totalQty: 0,
        totalTonnes: 0,
        baseQty: 0,
        shipQty: 0,
        exchangeQty: 0,
        locations: []
      };
      position.totalQty += quantity;
      position.totalTonnes += tonnes;
      if (kind === "base") position.baseQty += quantity;
      if (kind === "ship") position.shipQty += quantity;
      if (kind === "exchange") position.exchangeQty += quantity;
      position.locations.push({ warehouseId, warehouseName: name, warehouseType: kind, holderId, quantity, tonnes });
      inventory.set(matId, position);
    }
  }

  for (const position of inventory.values()) {
    position.totalQty = round(position.totalQty);
    position.totalTonnes = round(position.totalTonnes);
    position.baseQty = round(position.baseQty);
    position.shipQty = round(position.shipQty);
    position.exchangeQty = round(position.exchangeQty);
  }

  return inventory;
}

function buildDemandPositions(snapshot: GameSnapshot, context: PlayerPlanningContext, materials: MaterialCatalog): Map<number, DemandPosition> {
  const demand = new Map<number, DemandPosition>();

  for (const wishlist of snapshot.wishlists) {
    const title = text(wishlist.title) || `Wishlist ${numberValue(wishlist.id) ?? "?"}`;
    for (const mat of recordArray(wishlist.mats)) addDemand(demand, mat, materials, title, `Wishlist ${title}`, 1, context.autonomyHours, "wishlist");
  }

  const recipesById = new Map<number, Record<string, unknown>>();
  for (const recipe of recordArray(snapshot.gameData.recipes)) {
    const id = numberValue(recipe.id);
    if (id) recipesById.set(id, recipe);
  }

  const planningMultiplier = Math.max(1, Math.ceil(context.autonomyHours / 12));
  for (const base of snapshot.bases) {
    const baseName = text(base.name) || `Base ${numberValue(base.id) ?? "?"}`;
    for (const order of recordArray(base.productionOrders)) {
      const nestedRecipe = recordValue(order.recipe);
      const recipeId = numberValue(order.recipeId) ?? numberValue(order.rId) ?? numberValue(nestedRecipe?.id);
      const recipe = recipeId ? recipesById.get(recipeId) : undefined;
      for (const input of recordArray(recipe?.inputs)) {
        addDemand(demand, input, materials, baseName, `Production recipe ${recipeId ?? "unknown"} at ${baseName}`, planningMultiplier, context.autonomyHours, "production");
      }
    }
  }

  for (const position of demand.values()) {
    position.requiredQty = round(position.requiredQty);
    position.wishlistQty = round(position.wishlistQty);
    position.productionQtyPer12h = round(position.productionQtyPer12h);
  }

  return demand;
}

function addDemand(
  demand: Map<number, DemandPosition>,
  mat: Record<string, unknown>,
  materials: MaterialCatalog,
  affectedBase: string,
  reason: string,
  multiplier: number,
  planningHorizonHours: number,
  sourceType: "wishlist" | "production"
): void {
  const matId = materialId(mat);
  const baseQuantity = materialQuantity(mat);
  const quantity = baseQuantity * multiplier;
  if (!matId || baseQuantity <= 0 || quantity <= 0) return;
  const entry = demand.get(matId) ?? {
    matId,
    matName: materials.get(matId)?.name ?? text(mat.matName) ?? text(mat.name) ?? `Material ${matId}`,
    requiredQty: 0,
    wishlistQty: 0,
    productionQtyPer12h: 0,
    affectedBases: [],
    reasons: [],
    planningHorizonHours
  };
  entry.requiredQty += quantity;
  if (sourceType === "wishlist") entry.wishlistQty += baseQuantity;
  if (sourceType === "production") entry.productionQtyPer12h += baseQuantity;
  if (!entry.affectedBases.includes(affectedBase)) entry.affectedBases.push(affectedBase);
  if (!entry.reasons.includes(reason)) entry.reasons.push(reason);
  demand.set(matId, entry);
}

function buildWarehousePositions(snapshot: GameSnapshot, materials: MaterialCatalog): WarehousePosition[] {
  return snapshot.warehouses.map((warehouse) => {
    const cap = numberValue(warehouse.cap);
    const usedTonnes = recordArray(warehouse.mats).reduce((sum, mat) => {
      const matId = materialId(mat);
      const quantity = materialQuantity(mat);
      return sum + quantity * (matId ? materials.get(matId)?.weight ?? 1 : 1);
    }, 0);
    return {
      id: numberValue(warehouse.id),
      name: warehouseName(snapshot, warehouse),
      type: warehouseKind(warehouse),
      holderId: numberValue(warehouse.holderId),
      cap,
      usedTonnes: round(usedTonnes),
      utilization: cap && cap > 0 ? round(usedTonnes / cap) : 0,
      freeTonnes: cap && cap > 0 ? round(Math.max(0, cap - usedTonnes)) : undefined
    };
  });
}

function industryName(id?: number): string | undefined {
  if (id === 1) return "Construction";
  if (id === 2) return "Manufacturing";
  if (id === 3) return "Agriculture";
  if (id === 4) return "Resource Extraction";
  if (id === 5) return "Metallurgy";
  if (id === 6) return "Chemistry";
  if (id === 7) return "Electronics";
  if (id === 8) return "Food Production";
  if (id === 9) return "Science";
  return undefined;
}

export function materialId(mat: Record<string, unknown>): number | undefined {
  return numberValue(mat.matId) ?? numberValue(mat.id) ?? numberValue(mat.i);
}

export function materialQuantity(mat: Record<string, unknown>): number {
  return numberValue(mat.qty) ?? numberValue(mat.quantity) ?? numberValue(mat.am) ?? numberValue(mat.a) ?? 0;
}

export function warehouseName(snapshot: GameSnapshot, warehouse: Record<string, unknown>): string {
  const type = warehouseKind(warehouse);
  const holderId = numberValue(warehouse.holderId);
  if (type === "exchange") return "Exchange warehouse";
  if (type === "ship") return text(warehouse.name) || `Ship warehouse ${holderId ?? numberValue(warehouse.id) ?? "?"}`;
  if (type === "base") {
    const warehouseId = numberValue(warehouse.id);
    const base = snapshot.bases.find((item) => numberValue(item.id) === holderId || numberValue(item.warehouseId) === warehouseId);
    return text(base?.name) || `Base warehouse ${holderId ?? warehouseId ?? "?"}`;
  }
  return text(warehouse.name) || `Warehouse ${numberValue(warehouse.id) ?? "?"}`;
}

export function warehouseKind(warehouse: Record<string, unknown>): WarehouseKind {
  const type = numberValue(warehouse.type);
  if (type === 1) return "base";
  if (type === 2) return "ship";
  if (type === 3) return "exchange";
  return "other";
}

function computeCashTrendPct(cashHistory: Record<string, unknown>[]): number | undefined {
  const values = cashHistory
    .map((item) => numberValue(item.cash) ?? numberValue(item.balance) ?? numberValue(item.value))
    .filter((value): value is number => value !== undefined && value > 0);
  if (values.length < 2) return undefined;
  const newest = values[0];
  const oldest = values[values.length - 1];
  return oldest > 0 ? round(((newest - oldest) / oldest) * 100) : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
