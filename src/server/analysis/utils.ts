import type { ActionPlan, ExpansionCandidate, StockoutRisk } from "../../shared/schemas.js";

export function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value));
}

export function formatMoney(cents: number): string {
  if (cents < 0) return "n/a";
  return `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

export function formatPct(value: number): string {
  return `${round(value)}%`;
}

export function severityScore(priority: ActionPlan["priority"] | StockoutRisk["severity"] | ExpansionCandidate["priority"]): number {
  return { low: 1, medium: 2, high: 3, critical: 4 }[priority];
}

export function priorityFromScore(score: number): ActionPlan["priority"] {
  if (score >= 85) return "critical";
  if (score >= 65) return "high";
  if (score >= 40) return "medium";
  return "low";
}

export function confidenceFromScore(score: number): NonNullable<ActionPlan["confidence"]> {
  if (score >= 70) return "high";
  if (score >= 45) return "medium";
  return "low";
}
