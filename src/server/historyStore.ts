import type {
  HistorySummary,
  SitrepResponse,
  SnapshotHistoryEntry,
  TrendSignal
} from "../shared/schemas.js";
import { numberValue, round } from "./analysis/utils.js";

const MAX_HISTORY_ENTRIES = 12;

export class StrategyHistoryStore {
  private readonly entriesBySession = new Map<string, SnapshotHistoryEntry[]>();

  record(sessionId: string, sitrep: SitrepResponse): HistorySummary {
    const current = this.entriesBySession.get(sessionId) ?? [];
    const entry = sanitizeSitrep(sitrep);
    const entries = [...current, entry].slice(-MAX_HISTORY_ENTRIES);
    this.entriesBySession.set(sessionId, entries);
    return this.summary(sessionId);
  }

  summary(sessionId: string): HistorySummary {
    const entries = this.entriesBySession.get(sessionId) ?? [];
    return {
      entries,
      trendSignals: buildTrendSignals(entries),
      lastRunAt: entries.at(-1)?.generatedAt
    };
  }

  clear(sessionId: string): void {
    this.entriesBySession.delete(sessionId);
  }
}

function sanitizeSitrep(sitrep: SitrepResponse): SnapshotHistoryEntry {
  const topActionIds = sitrep.actionPlans.slice(0, 4).map((plan) => plan.id);
  const profitableRecipes = [
    ...(sitrep.profitability?.companyFit ?? []),
    ...(sitrep.profitability?.globalTargets ?? [])
  ];
  const chains = sitrep.profitability?.chainOpportunities ?? sitrep.chainOpportunities ?? [];
  const actionableMarketSignals = sitrep.marketSignals
    .filter((signal) => signal.recommendation === "buy" || signal.recommendation === "sell" || signal.recommendation === "restock")
    .slice(0, 6);

  return {
    id: crypto.randomUUID(),
    generatedAt: sitrep.generatedAt,
    fetchedAt: sitrep.rawSnapshot?.fetchedAt,
    companyName: String(sitrep.rawSnapshot?.company.name ?? sitrep.rawSnapshot?.company.companyName ?? "Unknown company"),
    cash: sitrep.situation?.cash.current ?? numberValue(sitrep.rawSnapshot?.company.cash),
    companyValue: numberValue(sitrep.rawSnapshot?.company.value),
    topActionTitle: sitrep.actionPlans[0]?.title,
    topActionIds,
    highPriorityCount: sitrep.actionPlans.filter((plan) => plan.priority === "critical" || plan.priority === "high").length,
    stockoutMatIds: sitrep.stockoutRisks.slice(0, 8).map((risk) => risk.matId),
    stockoutMatNames: sitrep.stockoutRisks.slice(0, 8).map((risk) => risk.matName),
    profitableRecipeIds: profitableRecipes.slice(0, 8).map((recipe) => recipe.recipeId),
    profitableRecipeNames: profitableRecipes.slice(0, 8).map((recipe) => recipe.title),
    marketSignalMatIds: actionableMarketSignals.map((signal) => signal.matId),
    marketSignalMatNames: actionableMarketSignals.map((signal) => signal.matName),
    chainIds: chains.slice(0, 6).map((chain) => chain.chainId),
    chainNames: chains.slice(0, 6).map((chain) => chain.title),
    warnings: sitrep.warnings.slice(0, 5)
  };
}

function buildTrendSignals(entries: SnapshotHistoryEntry[]): TrendSignal[] {
  if (entries.length === 0) return [];
  const latest = entries.at(-1)!;
  const previous = entries.at(-2);
  const signals: TrendSignal[] = [];

  if (previous?.cash !== undefined && latest.cash !== undefined) {
    signals.push(movementSignal("cash", "Cash trend", previous.cash, latest.cash));
  }
  if (previous?.companyValue !== undefined && latest.companyValue !== undefined) {
    signals.push(movementSignal("company_value", "CV trend", previous.companyValue, latest.companyValue));
  }

  for (const repeated of repeatedItems(entries, (entry) => entry.stockoutMatNames).slice(0, 4)) {
    signals.push({
      id: `stockout-${slug(repeated.name)}`,
      kind: "stockout",
      severity: repeated.count >= 3 ? "critical" : "warning",
      title: `Repeated shortage: ${repeated.name}`,
      summary: `${repeated.name} appeared as a stockout risk in ${repeated.count} recent snapshot(s).`,
      count: repeated.count,
      actionIds: [],
      evidence: repeated.examples
    });
  }

  for (const repeated of repeatedItems(entries, (entry) => entry.profitableRecipeNames).slice(0, 4)) {
    signals.push({
      id: `profit-${slug(repeated.name)}`,
      kind: "profitability",
      severity: "positive",
      title: `Persistent profit lane: ${repeated.name}`,
      summary: `${repeated.name} stayed in the profitability set for ${repeated.count} recent snapshot(s).`,
      count: repeated.count,
      actionIds: [],
      evidence: repeated.examples
    });
  }

  for (const repeated of repeatedItems(entries, (entry) => entry.marketSignalMatNames).slice(0, 4)) {
    signals.push({
      id: `market-${slug(repeated.name)}`,
      kind: "market",
      severity: repeated.count >= 3 ? "warning" : "info",
      title: `Persistent market signal: ${repeated.name}`,
      summary: `${repeated.name} has remained actionable in ${repeated.count} recent snapshot(s).`,
      count: repeated.count,
      actionIds: [],
      evidence: repeated.examples
    });
  }

  if (previous?.topActionTitle && latest.topActionTitle && previous.topActionTitle !== latest.topActionTitle) {
    signals.push({
      id: "recommendation-changed",
      kind: "recommendation",
      severity: "info",
      title: "Top recommendation changed",
      summary: `Top move changed from ${previous.topActionTitle} to ${latest.topActionTitle}.`,
      actionIds: latest.topActionIds,
      evidence: [`Previous: ${previous.topActionTitle}`, `Current: ${latest.topActionTitle}`]
    });
  }

  return signals.slice(0, 12);
}

function movementSignal(kind: "cash" | "company_value", title: string, previous: number, current: number): TrendSignal {
  const delta = current - previous;
  const deltaPct = previous !== 0 ? round((delta / previous) * 100) : undefined;
  const rising = delta >= 0;
  return {
    id: kind,
    kind,
    severity: rising ? "positive" : "warning",
    title,
    summary: `${title} ${rising ? "improved" : "fell"} by ${formatDelta(delta)}${deltaPct !== undefined ? ` (${deltaPct}%)` : ""} since the last run.`,
    previous,
    current,
    delta,
    deltaPct,
    actionIds: [],
    evidence: []
  };
}

function repeatedItems(
  entries: SnapshotHistoryEntry[],
  picker: (entry: SnapshotHistoryEntry) => string[]
): Array<{ name: string; count: number; examples: string[] }> {
  const counts = new Map<string, { name: string; count: number; examples: string[] }>();
  for (const entry of entries) {
    for (const name of new Set(picker(entry).filter(Boolean))) {
      const current = counts.get(name) ?? { name, count: 0, examples: [] };
      current.count += 1;
      current.examples.push(entry.generatedAt);
      counts.set(name, current);
    }
  }
  return [...counts.values()]
    .filter((item) => item.count >= 2)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function formatDelta(cents: number): string {
  const sign = cents >= 0 ? "+" : "-";
  return `${sign}$${Math.abs(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "signal";
}
