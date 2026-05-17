import type {
  ActionPlan,
  PlayerPlanningContext,
  ProjectedMaterialNeed,
  ProjectionBand,
  ProjectionHorizon,
  ProjectionSet
} from "../../shared/schemas.js";
import type { NormalizedSnapshot } from "./normalizers.js";
import { clamp, formatMoney, round } from "./utils.js";

export const DEFAULT_PROJECTION_HOURS = [12, 24, 72, 168] as const;

export function projectionHorizons(context: PlayerPlanningContext): ProjectionHorizon[] {
  const hours = context.projectionHours?.length ? context.projectionHours : [...DEFAULT_PROJECTION_HOURS];
  return [...new Set(hours)]
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b)
    .map((value) => ({
      id: horizonId(value),
      label: horizonLabel(value),
      hours: value
    }));
}

export function buildProjectionBase(normalized: NormalizedSnapshot, context: PlayerPlanningContext): Pick<ProjectionSet, "horizons" | "materialNeeds" | "warnings"> {
  const horizons = projectionHorizons(context);
  const materialNeeds = horizons.flatMap((horizon) => projectedNeedsForHorizon(normalized, horizon));
  const warnings = projectionWarnings(normalized);
  return { horizons, materialNeeds, warnings };
}

export function buildProjections(normalized: NormalizedSnapshot, actionPlans: ActionPlan[], context: PlayerPlanningContext): ProjectionSet {
  const base = buildProjectionBase(normalized, context);
  return {
    ...base,
    bands: base.horizons.map((horizon) => projectionBand(normalized, horizon, base.materialNeeds, actionPlans, base.warnings))
  };
}

export function addProjectionTiming(actionPlans: ActionPlan[], base: Pick<ProjectionSet, "horizons" | "materialNeeds">): ActionPlan[] {
  return actionPlans.map((plan) => {
    const current = plan.horizonId ? base.horizons.find((horizon) => horizon.id === plan.horizonId) : undefined;
    const inferred = current ?? inferHorizonForPlan(plan, base);
    if (!inferred) return plan;
    const materialNeed = materialIdFromPlan(plan) ? earliestNeedForMaterial(base.materialNeeds, materialIdFromPlan(plan)!) : undefined;
    return {
      ...plan,
      horizonId: inferred.id,
      horizonLabel: inferred.label,
      latestUsefulByHours: plan.latestUsefulByHours ?? inferred.hours,
      futureTriggers: plan.futureTriggers ?? futureTriggersForPlan(plan, materialNeed)
    };
  });
}

export function earliestNeedForMaterial(materialNeeds: ProjectedMaterialNeed[], matId: number): ProjectedMaterialNeed | undefined {
  return materialNeeds
    .filter((need) => need.matId === matId && need.netNeedQty > 0)
    .sort((a, b) => a.hours - b.hours)[0];
}

function projectedNeedsForHorizon(normalized: NormalizedSnapshot, horizon: ProjectionHorizon): ProjectedMaterialNeed[] {
  return Array.from(normalized.demand.values())
    .map((demand) => {
      const inventory = normalized.inventory.get(demand.matId);
      const material = normalized.materials.get(demand.matId);
      const productionCycles = Math.max(1, Math.ceil(horizon.hours / 12));
      const requiredQty = round(demand.wishlistQty + demand.productionQtyPer12h * productionCycles);
      const availableQty = round(inventory?.totalQty ?? 0);
      const netNeedQty = round(Math.max(0, requiredQty - availableQty));
      return {
        horizonId: horizon.id,
        horizonLabel: horizon.label,
        hours: horizon.hours,
        matId: demand.matId,
        matName: demand.matName,
        requiredQty,
        availableQty,
        netNeedQty,
        tonnes: round(netNeedQty * (material?.weight ?? 1))
      } satisfies ProjectedMaterialNeed;
    })
    .filter((need) => need.requiredQty > 0 || need.availableQty > 0)
    .sort((a, b) => b.netNeedQty - a.netNeedQty || b.requiredQty - a.requiredQty)
    .slice(0, 16);
}

function projectionBand(
  normalized: NormalizedSnapshot,
  horizon: ProjectionHorizon,
  materialNeeds: ProjectedMaterialNeed[],
  actionPlans: ActionPlan[],
  warnings: string[]
): ProjectionBand {
  const needs = materialNeeds.filter((need) => need.horizonId === horizon.id);
  const shortages = needs.filter((need) => need.netNeedQty > 0);
  const lead = shortages[0];
  const actionIds = actionIdsForBand(horizon, shortages, actionPlans);
  const leadAction = actionIds.length > 0 ? actionPlans.find((plan) => plan.id === actionIds[0]) : undefined;
  return {
    horizonId: horizon.id,
    summary: lead
      ? `${horizon.label}: projected ${Math.ceil(lead.netNeedQty).toLocaleString()} ${lead.matName} net need.`
      : leadAction?.category === "profitability"
        ? `${horizon.label}: profitability work centers on ${leadAction.title}.`
      : `${horizon.label}: no projected material shortfall from visible demand.`,
    confidence: confidenceForHorizon(horizon, warnings, normalized),
    actionIds,
    materialNeeds: shortages.slice(0, 4),
    constraints: constraintsForBand(normalized, horizon, shortages),
    inspectNext: inspectNextForBand(horizon, shortages, actionPlans, actionIds)
  };
}

function actionIdsForBand(horizon: ProjectionHorizon, shortages: ProjectedMaterialNeed[], actionPlans: ActionPlan[]): string[] {
  const ids = new Set<string>();
  for (const plan of actionPlans) {
    if (plan.horizonId === horizon.id && plan.category === "profitability") ids.add(plan.id);
  }
  for (const need of shortages.slice(0, 3)) {
    for (const plan of actionPlans) {
      if (plan.id.includes(`-${need.matId}`) || plan.id.includes(`-${need.matId}-`)) ids.add(plan.id);
    }
  }
  if (ids.size === 0 && horizon.hours >= 72) {
    const profitTarget = actionPlans.find((plan) => plan.category === "profitability");
    if (profitTarget) ids.add(profitTarget.id);
  }
  if (ids.size === 0 && horizon.hours >= 72) {
    const expansion = actionPlans.find((plan) => plan.category === "expansion");
    if (expansion) ids.add(expansion.id);
  }
  if (ids.size === 0 && horizon.hours <= 24 && actionPlans[0]) ids.add(actionPlans[0].id);
  return [...ids].slice(0, 4);
}

function constraintsForBand(normalized: NormalizedSnapshot, horizon: ProjectionHorizon, shortages: ProjectedMaterialNeed[]): string[] {
  const constraints = [
    shortages.length > 0 ? `${shortages.length} material groups need coverage by ${horizon.label}.` : "Visible production and wishlist demand is covered by current inventory.",
    normalized.cash > 0 ? `${formatMoney(normalized.cash)} cash must cover any staged buys.` : "Cash is unavailable in the snapshot.",
    normalized.warehouses.some((warehouse) => warehouse.utilization > 0.85) ? "Warehouse capacity should be checked before long-horizon buying." : undefined,
    horizon.hours >= 72 ? "Longer-horizon projections assume active production recipes keep repeating every 12 hours." : undefined
  ];
  return uniqueStrings(constraints);
}

function inspectNextForBand(horizon: ProjectionHorizon, shortages: ProjectedMaterialNeed[], actionPlans: ActionPlan[], actionIds: string[]): string[] {
  const linkedActions = actionPlans.filter((plan) => actionIds.includes(plan.id));
  return uniqueStrings([
    shortages[0] ? `Verify live supply for ${shortages[0].matName} before ${horizon.label}.` : `Recheck production and wishlist state before ${horizon.label}.`,
    linkedActions[0] ? `Prepare "${linkedActions[0].title}" if the live state still matches.` : undefined,
    horizon.hours >= 72 ? "Review base plans, production slots, and material storage before committing cash." : undefined
  ]);
}

function confidenceForHorizon(horizon: ProjectionHorizon, warnings: string[], normalized: NormalizedSnapshot): ProjectionBand["confidence"] {
  if (warnings.length > 1 || normalized.demand.size === 0) return "low";
  if (horizon.hours <= 24) return "high";
  if (horizon.hours <= 72) return "medium";
  return "low";
}

function projectionWarnings(normalized: NormalizedSnapshot): string[] {
  const warnings = [...normalized.warnings];
  if (normalized.demand.size === 0) warnings.push("No active production or wishlist demand was visible, so projections are limited to inspection guidance.");
  if ([...normalized.demand.values()].every((demand) => demand.productionQtyPer12h <= 0)) warnings.push("No active production recipe inputs were visible; long-horizon production burn may be understated.");
  if (normalized.basePlans.length > 0) warnings.push("Base-plan material requirements are not exposed in the current snapshot, so expansion projections remain preparatory.");
  return [...new Set(warnings)];
}

function inferHorizonForPlan(plan: ActionPlan, base: Pick<ProjectionSet, "horizons" | "materialNeeds">): ProjectionHorizon | undefined {
  const matId = materialIdFromPlan(plan);
  const need = matId ? earliestNeedForMaterial(base.materialNeeds, matId) : undefined;
  if (need) return base.horizons.find((horizon) => horizon.id === need.horizonId);
  if (plan.category === "expansion") return base.horizons.find((horizon) => horizon.hours >= 72) ?? base.horizons.at(-1);
  return base.horizons[0];
}

function futureTriggersForPlan(plan: ActionPlan, need: ProjectedMaterialNeed | undefined): string[] {
  if (need) {
    return [
      `${need.matName} net need reaches ${Math.ceil(need.netNeedQty).toLocaleString()} units by ${need.horizonLabel}.`,
      "Live inventory, production orders, or market depth changes could move this earlier or later."
    ];
  }
  if (plan.category === "expansion") return ["A visible capacity ceiling, profitable base-plan material list, or repeated stockout pressure should promote this from prepare to execute."];
  return ["A fresh snapshot can change the useful timing for this action."];
}

function materialIdFromPlan(plan: ActionPlan): number | undefined {
  const match = plan.id.match(/(?:restock|market|move|project-restock)-(\d+)/);
  return match ? Number(match[1]) : undefined;
}

function horizonId(hours: number): string {
  return hours % 24 === 0 ? `d${hours / 24}` : `h${hours}`;
}

function horizonLabel(hours: number): string {
  if (hours === 12) return "Next 12h";
  if (hours === 24) return "1 Day";
  if (hours % 24 === 0) return `${hours / 24} Days`;
  return `${hours}h`;
}

function uniqueStrings(items: Array<string | undefined>): string[] {
  return [...new Set(items.filter((item): item is string => Boolean(item && item.trim())))];
}

export function projectionNeedScore(need: ProjectedMaterialNeed, cashImpactPct: number, cashRiskLevel: PlayerPlanningContext["cashRiskLevel"]): number {
  const urgency = clamp(80 - need.hours / 4);
  const needScale = clamp((need.netNeedQty / Math.max(need.requiredQty, 1)) * 100);
  const cashLimit = cashRiskLevel === "conservative" ? 12 : cashRiskLevel === "aggressive" ? 45 : 25;
  const cashFit = cashImpactPct <= 0 ? 70 : clamp(100 - (cashImpactPct / cashLimit) * 70);
  return round(urgency * 0.35 + needScale * 0.25 + cashFit * 0.25 + 50 * 0.15);
}
