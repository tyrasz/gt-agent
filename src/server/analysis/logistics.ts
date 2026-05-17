import type { LogisticsMove, StockoutRisk } from "../../shared/schemas.js";
import type { NormalizedSnapshot, InventoryLocation } from "./normalizers.js";
import { round } from "./utils.js";

export function computeLogisticsMoves(normalized: NormalizedSnapshot, risks: StockoutRisk[]): LogisticsMove[] {
  const shipWarehouse = normalized.warehouses.find((warehouse) => warehouse.type === "ship");
  const moves: LogisticsMove[] = [];

  for (const risk of risks.slice(0, 10)) {
    const inventory = normalized.inventory.get(risk.matId);
    if (!inventory) continue;
    const targetName = risk.affectedBases[0] ?? "highest-priority base";
    const source = chooseSource(inventory.locations, targetName);
    if (!source) continue;
    const quantity = Math.min(risk.shortageQty, source.quantity);
    if (quantity <= 0) continue;
    const material = normalized.materials.get(risk.matId);
    const tonnes = quantity * (material?.weight ?? 1);
    const destination = normalized.warehouses.find((warehouse) => warehouse.type === "base" && warehouse.name === targetName);
    const capacityNote = destination?.freeTonnes !== undefined && destination.freeTonnes < tonnes
      ? `Destination has only ${Math.floor(destination.freeTonnes).toLocaleString()} t free; split the transfer or expand storage first.`
      : "Unload into the destination warehouse before restarting dependent production.";

    moves.push({
      from: source.warehouseName,
      to: targetName,
      matId: risk.matId,
      materialName: risk.matName,
      quantity: round(quantity),
      tonnes: round(tonnes),
      shipName: shipWarehouse?.name,
      reason: `${targetName} is short ${Math.round(risk.shortageQty).toLocaleString()} ${risk.matName}.`,
      steps: [
        `Load ${Math.round(quantity).toLocaleString()} ${risk.matName} at ${source.warehouseName}.`,
        shipWarehouse ? `Route ${shipWarehouse.name} to ${targetName}.` : `Route a cargo ship to ${targetName}.`,
        capacityNote
      ]
    });
  }

  return moves;
}

function chooseSource(locations: InventoryLocation[], targetName: string): InventoryLocation | undefined {
  return locations
    .filter((location) => location.quantity > 0 && location.warehouseName !== targetName)
    .sort((a, b) => locationScore(b) - locationScore(a))
    [0];
}

function locationScore(location: InventoryLocation): number {
  const typeScore = location.warehouseType === "exchange" ? 30 : location.warehouseType === "ship" ? 20 : location.warehouseType === "base" ? 10 : 0;
  return typeScore + location.quantity;
}
