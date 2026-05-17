import type { PlayerPlanningContext, StockoutRisk } from "../../shared/schemas.js";
import type { NormalizedSnapshot } from "./normalizers.js";
import { round, severityScore } from "./utils.js";

export function computeStockoutRisks(normalized: NormalizedSnapshot, context: PlayerPlanningContext): StockoutRisk[] {
  return Array.from(normalized.demand.values())
    .map((demand) => {
      const inventory = normalized.inventory.get(demand.matId);
      const availableQty = inventory?.totalQty ?? 0;
      const shortageQty = Math.max(0, demand.requiredQty - availableQty);
      const hoursUntilStockout = demand.requiredQty > 0 ? Math.max(0, round((availableQty / Math.max(demand.requiredQty, 1)) * context.autonomyHours)) : undefined;
      const severity = shortageSeverity(shortageQty, demand.requiredQty, hoursUntilStockout, context.autonomyHours);
      return {
        matId: demand.matId,
        matName: demand.matName,
        availableQty: round(availableQty),
        requiredQty: round(demand.requiredQty),
        shortageQty: round(shortageQty),
        hoursUntilStockout: shortageQty > 0 ? hoursUntilStockout : undefined,
        severity,
        affectedBases: demand.affectedBases
      } satisfies StockoutRisk;
    })
    .filter((risk) => risk.shortageQty > 0 || risk.severity !== "low")
    .sort((a, b) => severityScore(b.severity) - severityScore(a.severity) || b.shortageQty - a.shortageQty)
    .slice(0, 20);
}

function shortageSeverity(shortageQty: number, requiredQty: number, hoursUntilStockout: number | undefined, autonomyHours: number): StockoutRisk["severity"] {
  if (shortageQty <= 0) return "low";
  const ratio = shortageQty / Math.max(requiredQty, 1);
  if (ratio >= 0.75 || (hoursUntilStockout !== undefined && hoursUntilStockout <= Math.min(4, autonomyHours / 2))) return "critical";
  if (ratio >= 0.4 || (hoursUntilStockout !== undefined && hoursUntilStockout <= autonomyHours * 0.5)) return "high";
  if (ratio >= 0.15) return "medium";
  return "low";
}
