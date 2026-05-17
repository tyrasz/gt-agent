import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BarChart3,
  Boxes,
  Brain,
  CheckCircle2,
  ClipboardList,
  Factory,
  FlaskConical,
  GitBranch,
  History,
  KeyRound,
  Loader2,
  LogOut,
  Map,
  RefreshCw,
  Rocket,
  Send,
  Settings2,
  ShieldCheck,
  Ship,
  TrendingUp
} from "lucide-react";
import type {
  ModelCatalogResponse,
  ModelOption,
  PressureSummary,
  Provider,
  SitrepResponse,
  WhatIfScenarioRequest,
  WhatIfScenarioResult
} from "../shared/schemas.js";

type Tab = "sitrep" | "market" | "profitability" | "chains" | "whatif" | "operations" | "logistics" | "expansion" | "raw";

const providerLabels: Record<Provider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Gemini"
};

const defaultModels: Record<Provider, string> = {
  openai: "gpt-5.5-mini",
  anthropic: "claude-sonnet-4-6",
  gemini: "gemini-3.1-pro-preview"
};

const fallbackModelOptions: Record<Provider, ModelOption[]> = {
  openai: ["gpt-5.5-mini", "gpt-5.4-mini", "gpt-5.2-mini", "gpt-4.1-mini", "gpt-5.5", "gpt-5.4", "gpt-4.1"].map((id) => ({ id, label: id, source: "fallback" })),
  anthropic: ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5"].map((id) => ({ id, label: id, source: "fallback" })),
  gemini: ["gemini-3.1-pro-preview", "gemini-3-flash-preview", "gemini-3.1-flash-lite", "gemini-2.5-pro", "gemini-2.5-flash"].map((id) => ({ id, label: id, source: "fallback" }))
};

function isLargeModelId(modelId: string): boolean {
  const lower = modelId.trim().toLowerCase();
  if (!lower) return false;
  return !/(^|[-_.])(flash-lite|flash|mini|nano|haiku)($|[-_.])/.test(lower);
}

const tabs: Array<{ id: Tab; label: string; icon: typeof ClipboardList }> = [
  { id: "sitrep", label: "Sitrep", icon: ClipboardList },
  { id: "market", label: "Market", icon: BarChart3 },
  { id: "profitability", label: "Profitability", icon: TrendingUp },
  { id: "chains", label: "Chains", icon: GitBranch },
  { id: "whatif", label: "What-if", icon: FlaskConical },
  { id: "operations", label: "Operations", icon: Factory },
  { id: "logistics", label: "Logistics", icon: Ship },
  { id: "expansion", label: "Expansion", icon: Rocket },
  { id: "raw", label: "Raw Snapshot", icon: Boxes }
];

export default function App() {
  const [provider, setProvider] = useState<Provider>("openai");
  const [model, setModel] = useState(defaultModels.openai);
  const [modelMode, setModelMode] = useState<"catalog" | "custom">("catalog");
  const [customModel, setCustomModel] = useState("");
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogResponse | null>(null);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelError, setModelError] = useState("");
  const [gtKey, setGtKey] = useState("");
  const [providerKey, setProviderKey] = useState("");
  const [hasSession, setHasSession] = useState(false);
  const [setupError, setSetupError] = useState("");
  const [setupLoading, setSetupLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("sitrep");
  const [sitrep, setSitrep] = useState<SitrepResponse | null>(null);
  const [runError, setRunError] = useState("");
  const [runLoading, setRunLoading] = useState(false);
  const [planning, setPlanning] = useState({
    userPrompt: "Give me a SITREP and the highest-impact actions before my next login.",
    nextLoginAt: "",
    autonomyHours: 12,
    cashRiskLevel: "balanced",
    shortTermGoal: "Keep production running and find profitable market moves",
    notes: ""
  });

  const priorityCounts = useMemo(() => {
    const counts = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const plan of sitrep?.actionPlans ?? []) counts[plan.priority] += 1;
    return counts;
  }, [sitrep]);

  const visibleModelOptions = modelCatalog?.models.length ? modelCatalog.models : fallbackModelOptions[provider];
  const selectedModel = modelMode === "custom" ? customModel.trim() : model;
  const selectedModelIsLarge = isLargeModelId(selectedModel);
  const modelTimeoutCopy = selectedModelIsLarge
    ? "Large model selected. This can wait up to 12 minutes."
    : provider === "openai"
      ? "Fast OpenAI models are selected by default. Full models like gpt-5.5 may take longer."
      : "Fast model selected. Larger models may take longer.";

  useEffect(() => {
    if (hasSession) {
      void loadModels(provider);
    }
  }, [hasSession, provider]);

  function updateProvider(nextProvider: Provider) {
    setProvider(nextProvider);
    setModel(defaultModels[nextProvider]);
    setModelMode("catalog");
    setCustomModel("");
    setModelCatalog(null);
    setModelError("");
    setProviderKey("");
  }

  async function loadModels(targetProvider = provider, refresh = false) {
    setModelLoading(true);
    setModelError("");
    try {
      const response = await fetch(`/api/session/models?provider=${targetProvider}&refresh=${refresh ? "true" : "false"}`, {
        credentials: "include"
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body.error ?? "Could not load provider models.");
      }
      const catalog = body as ModelCatalogResponse;
      setModelCatalog(catalog);
      setModel(catalog.defaultModel);
      setModelMode("catalog");
      setCustomModel("");
    } catch (error) {
      setModelCatalog(null);
      setModel(defaultModels[targetProvider]);
      setModelError(error instanceof Error ? error.message : "Could not load provider models.");
    } finally {
      setModelLoading(false);
    }
  }

  async function saveKeys(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSetupLoading(true);
    setSetupError("");
    try {
      const response = await fetch("/api/session/keys", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gtApiKey: gtKey,
          providerKeys: { [provider]: providerKey }
        })
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? "Could not save session keys.");
      }
      setGtKey("");
      setProviderKey("");
      setHasSession(true);
      setModelCatalog(null);
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : "Could not save session keys.");
    } finally {
      setSetupLoading(false);
    }
  }

  async function clearSession() {
    await fetch("/api/session", { method: "DELETE", credentials: "include" });
    setHasSession(false);
    setSitrep(null);
    setModelCatalog(null);
    setModelError("");
  }

  async function generateSitrep(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setRunLoading(true);
    setRunError("");
    try {
      const response = await fetch("/api/agent/sitrep", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          model: selectedModel,
          planningContext: {
            ...planning,
            autonomyHours: Number(planning.autonomyHours),
            nextLoginAt: planning.nextLoginAt || undefined,
            userPrompt: planning.userPrompt.trim() || undefined,
            notes: planning.notes || undefined
          },
          refresh: {
            forceCompany: true,
            forceMarket: true,
            forceGameData: false
          }
        })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const detail = body.details?.endpoint ? ` (${body.details.endpoint})` : "";
        throw new Error(`${body.error ?? "Could not generate sitrep."}${detail}`);
      }
      setSitrep(body);
      setActiveTab("sitrep");
    } catch (error) {
      setRunError(error instanceof Error ? error.message : "Could not generate sitrep.");
    } finally {
      setRunLoading(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            <Brain size={22} />
          </div>
          <div>
            <h1>GT Agent</h1>
            <p>Galactic Tycoons operations console</p>
          </div>
        </div>
        <div className="topbar-actions">
          <span className={hasSession ? "status-pill ready" : "status-pill"}>
            {hasSession ? <CheckCircle2 size={15} /> : <ShieldCheck size={15} />}
            {hasSession ? "Session active" : "No session"}
          </span>
          {hasSession ? (
            <button className="icon-button" type="button" onClick={clearSession} title="Clear session">
              <LogOut size={18} />
            </button>
          ) : null}
        </div>
      </header>

      {!hasSession ? (
        <section className="setup-grid">
          <form className="setup-panel" onSubmit={saveKeys}>
            <div className="section-heading">
              <KeyRound size={19} />
              <h2>Session Keys</h2>
            </div>
            <label>
              Galactic Tycoons API key
              <input
                value={gtKey}
                onChange={(event) => setGtKey(event.target.value)}
                autoComplete="off"
                type="password"
                required
              />
            </label>
            <div className="field-row">
              <label>
                Provider
                <select value={provider} onChange={(event) => updateProvider(event.target.value as Provider)}>
                  <option value="openai">OpenAI</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="gemini">Gemini</option>
                </select>
              </label>
              <label>
                Model
                <input value={model} onChange={(event) => setModel(event.target.value)} required />
              </label>
            </div>
            <label>
              {providerLabels[provider]} API key
              <input
                value={providerKey}
                onChange={(event) => setProviderKey(event.target.value)}
                autoComplete="off"
                type="password"
                required
              />
            </label>
            <div className="disclosure">
              <ShieldCheck size={18} />
              <span>Keys stay in backend memory for this local session and are cleared when the server stops or the session is closed.</span>
            </div>
            {setupError ? <p className="error-line">{setupError}</p> : null}
            <button className="primary-button" type="submit" disabled={setupLoading}>
              {setupLoading ? <Loader2 className="spin" size={18} /> : <ShieldCheck size={18} />}
              Start Session
            </button>
          </form>
          <aside className="brief-panel">
            <div className="metric-strip">
              <div>
                <span>Mode</span>
                <strong>Read-only</strong>
              </div>
              <div>
                <span>Storage</span>
                <strong>Memory</strong>
              </div>
              <div>
                <span>Providers</span>
                <strong>3</strong>
              </div>
            </div>
            <div className="capability-list">
              <div><TrendingUp size={18} /> Market pricing and volume signals</div>
              <div><Factory size={18} /> Restocking and production bottlenecks</div>
              <div><Ship size={18} /> Cargo placement and transfer manifests</div>
              <div><Map size={18} /> Base plan and expansion review</div>
            </div>
          </aside>
        </section>
      ) : (
        <section className="console-layout">
          <form className="console-panel" onSubmit={generateSitrep}>
            <div className="console-header">
              <div className="section-heading">
                <ClipboardList size={19} />
                <h2>Command Console</h2>
              </div>
              <span className="status-pill ready">Fresh GT snapshot on submit</span>
            </div>
            <label>
              Command prompt
              <textarea
                className="prompt-box"
                value={planning.userPrompt}
                onChange={(event) => setPlanning({ ...planning, userPrompt: event.target.value })}
                required
              />
            </label>
            <div className="control-grid">
              <label>
                Provider
                <select value={provider} onChange={(event) => updateProvider(event.target.value as Provider)}>
                  <option value="openai">OpenAI</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="gemini">Gemini</option>
                </select>
              </label>
              <label>
                Model
                <select
                  value={modelMode === "custom" ? "__custom" : model}
                  onChange={(event) => {
                    if (event.target.value === "__custom") {
                      setModelMode("custom");
                      setCustomModel(model);
                    } else {
                      setModelMode("catalog");
                      setModel(event.target.value);
                    }
                  }}
                >
                  {visibleModelOptions.map((option) => (
                    <option key={option.id} value={option.id}>{option.label ?? option.id}</option>
                  ))}
                  <option value="__custom">Custom model ID</option>
                </select>
              </label>
              <button
                className="secondary-button"
                type="button"
                onClick={() => loadModels(provider, true)}
                disabled={modelLoading}
              >
                {modelLoading ? <Loader2 className="spin" size={17} /> : <RefreshCw size={17} />}
                Refresh Models
              </button>
            </div>
            {modelMode === "custom" ? (
              <label>
                Custom model ID
                <input value={customModel} onChange={(event) => setCustomModel(event.target.value)} required />
              </label>
            ) : null}
            <p className={selectedModelIsLarge ? "helper-line timeout-line" : "helper-line"}>{modelTimeoutCopy}</p>
            <details className="advanced-context">
              <summary><Settings2 size={16} /> Planning controls</summary>
              <div className="context-grid">
                <label>
                  Short-term goal
                  <input
                    value={planning.shortTermGoal}
                    onChange={(event) => setPlanning({ ...planning, shortTermGoal: event.target.value })}
                    required
                  />
                </label>
                <label>
                  Autonomy hours
                  <input
                    type="number"
                    min="1"
                    max="168"
                    value={planning.autonomyHours}
                    onChange={(event) => setPlanning({ ...planning, autonomyHours: Number(event.target.value) })}
                    required
                  />
                </label>
                <label>
                  Cash risk
                  <select
                    value={planning.cashRiskLevel}
                    onChange={(event) => setPlanning({ ...planning, cashRiskLevel: event.target.value })}
                  >
                    <option value="conservative">Conservative</option>
                    <option value="balanced">Balanced</option>
                    <option value="aggressive">Aggressive</option>
                  </select>
                </label>
                <label>
                  Next login
                  <input
                    type="datetime-local"
                    value={planning.nextLoginAt}
                    onChange={(event) => setPlanning({ ...planning, nextLoginAt: event.target.value })}
                  />
                </label>
              </div>
              <label>
                Notes
                <textarea value={planning.notes} onChange={(event) => setPlanning({ ...planning, notes: event.target.value })} />
              </label>
            </details>
            {modelCatalog?.warnings.length ? <p className="warning-text">{modelCatalog.warnings.join(" ")}</p> : null}
            {modelError ? <p className="error-line">{modelError}</p> : null}
            {runError ? <p className="error-line">{runError}</p> : null}
            <button className="primary-button run-button" type="submit" disabled={runLoading || !selectedModel}>
              {runLoading ? <Loader2 className="spin" size={18} /> : <Send size={18} />}
              Generate Sitrep
            </button>
          </form>
          <div className="dashboard">
            <div className="summary-band">
              <div>
                <span>Snapshot</span>
                <strong>{sitrep?.rawSnapshot?.fetchedAt ? new Date(sitrep.rawSnapshot.fetchedAt).toLocaleString() : "Waiting"}</strong>
              </div>
              <div>
                <span>Critical</span>
                <strong>{priorityCounts.critical}</strong>
              </div>
              <div>
                <span>High</span>
                <strong>{priorityCounts.high}</strong>
              </div>
              <div>
                <span>Model</span>
                <strong>{providerLabels[provider]} / {selectedModel || "None"}</strong>
              </div>
              <div>
                <span>Pipeline</span>
                <strong>{sitrep?.diagnostics?.source ?? "Waiting"}</strong>
              </div>
            </div>

            <nav className="tabs" aria-label="Dashboard views">
              {tabs.map((tab) => {
                const Icon = tab.icon;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    className={activeTab === tab.id ? "tab active" : "tab"}
                    onClick={() => setActiveTab(tab.id)}
                  >
                    <Icon size={16} />
                    {tab.label}
                  </button>
                );
              })}
            </nav>

            <section className="dashboard-body">
              {!sitrep ? <EmptyState loading={runLoading} /> : <DashboardTab tab={activeTab} sitrep={sitrep} planning={planning} />}
            </section>
          </div>
        </section>
      )}
    </main>
  );
}

function EmptyState({ loading }: { loading: boolean }) {
  return (
    <div className="empty-state">
      {loading ? <Loader2 className="spin" size={30} /> : <Brain size={30} />}
      <h2>{loading ? "Building sitrep" : "Ready for a sitrep"}</h2>
    </div>
  );
}

function DashboardTab({
  tab,
  sitrep,
  planning
}: {
  tab: Tab;
  sitrep: SitrepResponse;
  planning: {
    userPrompt: string;
    nextLoginAt: string;
    autonomyHours: number;
    cashRiskLevel: string;
    shortTermGoal: string;
    notes: string;
  };
}) {
  if (tab === "market") {
    return (
      <div className="item-grid">
        {sitrep.marketSignals.map((signal) => (
          <article className="data-card" key={signal.matId}>
            <header>
              <strong>{signal.matName}</strong>
              <span className={`tag ${signal.recommendation}`}>{signal.recommendation}</span>
            </header>
            <dl>
              <div><dt>Current</dt><dd>{money(signal.currentPrice)}</dd></div>
              <div><dt>Spread</dt><dd>{signal.spreadPct}%</dd></div>
              <div><dt>Need</dt><dd>{Math.ceil(signal.netNeedQty ?? 0).toLocaleString()}</dd></div>
              <div><dt>Liquidity</dt><dd>{Math.round(signal.liquidityScore ?? 0)}</dd></div>
            </dl>
            <p>{signal.rationale[0]}</p>
          </article>
        ))}
      </div>
    );
  }

  if (tab === "operations") {
    return (
      <div className="item-grid">
        {sitrep.stockoutRisks.map((risk) => (
          <article className="data-card" key={risk.matId}>
            <header>
              <strong>{risk.matName}</strong>
              <span className={`priority ${risk.severity}`}>{risk.severity}</span>
            </header>
            <dl>
              <div><dt>Available</dt><dd>{risk.availableQty.toLocaleString()}</dd></div>
              <div><dt>Required</dt><dd>{risk.requiredQty.toLocaleString()}</dd></div>
              <div><dt>Short</dt><dd>{risk.shortageQty.toLocaleString()}</dd></div>
            </dl>
            <p>{risk.affectedBases.join(", ") || "Affected base unavailable"}</p>
          </article>
        ))}
      </div>
    );
  }

  if (tab === "profitability") {
    return <ProfitabilityPanel sitrep={sitrep} />;
  }

  if (tab === "chains") {
    return <ChainsPanel sitrep={sitrep} />;
  }

  if (tab === "whatif") {
    return <WhatIfPanel sitrep={sitrep} planning={planning} />;
  }

  if (tab === "logistics") {
    return (
      <div className="item-grid">
        {sitrep.logisticsMoves.map((move, index) => (
          <article className="data-card wide" key={`${move.matId}-${index}`}>
            <header>
              <strong>{move.materialName}</strong>
              <span>{Math.ceil(move.tonnes).toLocaleString()} t</span>
            </header>
            <p>{move.from} → {move.to}</p>
            <ol>{move.steps.map((step) => <li key={step}>{step}</li>)}</ol>
          </article>
        ))}
      </div>
    );
  }

  if (tab === "expansion") {
    return (
      <div className="item-grid">
        {sitrep.expansionCandidates.map((candidate, index) => (
          <article className="data-card wide" key={`${candidate.type}-${index}`}>
            <header>
              <strong>{candidate.title}</strong>
              <span className={`priority ${candidate.priority}`}>{candidate.priority}</span>
            </header>
            <p>{candidate.rationale.join(" ")}</p>
            {candidate.blockers.length > 0 ? <p className="warning-text">{candidate.blockers.join(" ")}</p> : null}
          </article>
        ))}
      </div>
    );
  }

  if (tab === "raw") {
    return <pre className="raw-box">{JSON.stringify(sitrep.rawSnapshot, null, 2)}</pre>;
  }

  return (
    <div className="sitrep-stack">
      <section className="briefing">
        <h2>{sitrep.summary}</h2>
        {sitrep.warnings.length > 0 ? (
          <div className="warning-row">
            <AlertTriangle size={18} />
            <span>{sitrep.warnings.join(" ")}</span>
          </div>
        ) : null}
        {sitrep.situation ? <SituationGrid situation={sitrep.situation} /> : null}
        {sitrep.diagnostics ? (
          <div className="diagnostic-row">
            <span>Pipeline: {sitrep.diagnostics.source}</span>
            <span>GT {Math.round(sitrep.diagnostics.timingsMs.snapshot ?? 0)} ms</span>
            <span>LLM {Math.round(sitrep.diagnostics.timingsMs.llm ?? 0)} ms</span>
            <span>Total {Math.round(sitrep.diagnostics.timingsMs.total ?? 0)} ms</span>
          </div>
        ) : null}
      </section>
      {sitrep.decisionBrief ? <DecisionBriefPanel brief={sitrep.decisionBrief} /> : null}
      <HistoryTrendPanel sitrep={sitrep} />
      {sitrep.projections ? <TimelinePanel sitrep={sitrep} /> : null}
      <div className="action-list">
        {sitrep.actionPlans.map((plan) => (
          <article className="action-card" key={plan.id}>
            <header>
              <div>
                <span className="category">{plan.category}</span>
                <h3>{plan.title}</h3>
              </div>
              <div className="plan-badges">
                {plan.horizonLabel ? <span className="horizon-chip">{plan.horizonLabel}</span> : null}
                {plan.profitPerHour !== undefined ? <span className="profit-chip">{moneyPerHour(plan.profitPerHour)}</span> : null}
                {plan.marginPct !== undefined ? <span className="profit-chip">{Math.round(plan.marginPct)}% margin</span> : null}
                {plan.profitabilityTag ? <span className="profit-chip">{plan.profitabilityTag}</span> : null}
                {plan.score !== undefined ? <span className="score-chip">{Math.round(plan.score)}</span> : null}
                {plan.confidence ? <span className="confidence-chip">{plan.confidence}</span> : null}
                <span className={`priority ${plan.priority}`}>{plan.priority}</span>
              </div>
            </header>
            <div className="action-copy">
              {plan.whyNow ? <p><strong>Why this is ranked:</strong> {plan.whyNow}</p> : null}
              <p><strong>Benefit:</strong> {plan.expectedBenefit}</p>
              <p><strong>Cost:</strong> {plan.costSummary}</p>
              <p><strong>Risk:</strong> {plan.risk}</p>
            </div>
            {plan.bestWhen || plan.avoidIf || plan.whatWouldChangeThis ? (
              <div className="action-context">
                {plan.bestWhen ? <p><strong>Best when:</strong> {plan.bestWhen}</p> : null}
                {plan.avoidIf ? <p><strong>Avoid if:</strong> {plan.avoidIf}</p> : null}
                {plan.whatWouldChangeThis ? <p><strong>Changes if:</strong> {plan.whatWouldChangeThis}</p> : null}
              </div>
            ) : null}
            <div className="evidence-list">
              {plan.evidence.slice(0, 4).map((item) => <span key={item}>{item}</span>)}
            </div>
            {plan.preparedCommands.length > 0 ? (
              <div className="command-list">
                {plan.preparedCommands.map((command) => (
                  <details key={command.title}>
                    <summary>{command.title}</summary>
                    <ol>{command.steps.map((step) => <li key={step}>{step}</li>)}</ol>
                  </details>
                ))}
              </div>
            ) : null}
          </article>
        ))}
      </div>
    </div>
  );
}

function TimelinePanel({ sitrep }: { sitrep: SitrepResponse }) {
  const actionTitleById = new globalThis.Map(sitrep.actionPlans.map((plan) => [plan.id, plan.title]));
  return (
    <section className="timeline-panel" aria-label="Projection Timeline">
      <div className="timeline-head">
        <div>
          <span className="category">Timeline</span>
          <h2>Projection roadmap</h2>
        </div>
        {sitrep.projections.warnings.length > 0 ? <span className="tag watch">{sitrep.projections.warnings.length} warnings</span> : null}
      </div>
      <div className="timeline-grid">
        {sitrep.projections.bands.map((band) => {
          const horizon = sitrep.projections.horizons.find((item) => item.id === band.horizonId);
          return (
            <article className="timeline-card" key={band.horizonId}>
              <header>
                <strong>{horizon?.label ?? band.horizonId}</strong>
                <span className={`confidence-chip ${band.confidence}`}>{band.confidence}</span>
              </header>
              <p>{band.summary}</p>
              {band.materialNeeds.length > 0 ? (
                <div className="timeline-section">
                  <span>Material pressure</span>
                  <div className="mini-list">
                    {band.materialNeeds.slice(0, 3).map((need) => (
                      <span key={`${band.horizonId}-${need.matId}`}>{need.matName}: {Math.ceil(need.netNeedQty).toLocaleString()} net</span>
                    ))}
                  </div>
                </div>
              ) : null}
              {band.actionIds.length > 0 ? (
                <div className="timeline-section">
                  <span>Top moves</span>
                  <div className="mini-list">
                    {band.actionIds.map((id) => <span key={id}>{actionTitleById.get(id) ?? id}</span>)}
                  </div>
                </div>
              ) : null}
              {band.constraints.length > 0 ? (
                <div className="timeline-section">
                  <span>Expected bottleneck</span>
                  <p>{band.constraints[0]}</p>
                </div>
              ) : null}
              <details>
                <summary>Inspect next</summary>
                <ul>{band.inspectNext.map((item) => <li key={item}>{item}</li>)}</ul>
              </details>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function HistoryTrendPanel({ sitrep }: { sitrep: SitrepResponse }) {
  const history = sitrep.history;
  const trends = sitrep.trendSignals ?? history?.trendSignals ?? [];
  const latest = history?.entries.at(-1);
  return (
    <section className="history-panel" aria-label="History and Trends">
      <div className="timeline-head">
        <div>
          <span className="category">History & trends</span>
          <h2>{history?.entries.length ? `${history.entries.length} run memory` : "First run memory"}</h2>
        </div>
        <span className="status-pill"><History size={15} /> Session-only</span>
      </div>
      {trends.length === 0 ? (
        <p className="muted-copy">
          Run another fresh SITREP to compare cash, CV, repeated shortages, persistent profit lanes, and recommendation changes.
        </p>
      ) : (
        <div className="trend-grid">
          {trends.slice(0, 6).map((signal) => (
            <article className="trend-card" key={signal.id}>
              <header>
                <strong>{signal.title}</strong>
                <span className={`tag ${signal.severity === "positive" ? "buy" : signal.severity === "warning" ? "watch" : signal.severity === "critical" ? "avoid" : "restock"}`}>
                  {signal.severity}
                </span>
              </header>
              <p>{signal.summary}</p>
              {signal.evidence.length > 0 ? (
                <div className="mini-list">
                  {signal.evidence.slice(0, 3).map((item) => <span key={item}>{item}</span>)}
                </div>
              ) : null}
            </article>
          ))}
        </div>
      )}
      {latest ? (
        <div className="mini-list">
          {latest.topActionTitle ? <span>Latest top move: {latest.topActionTitle}</span> : null}
          {latest.chainNames.slice(0, 2).map((chain) => <span key={chain}>Chain: {chain}</span>)}
          {latest.profitableRecipeNames.slice(0, 2).map((recipe) => <span key={recipe}>Profit lane: {recipe}</span>)}
        </div>
      ) : null}
    </section>
  );
}

function ProfitabilityPanel({ sitrep }: { sitrep: SitrepResponse }) {
  const profitability = sitrep.profitability;
  if (!profitability) {
    return (
      <div className="empty-state compact">
        <TrendingUp size={28} />
        <h2>No profitability data in this sitrep</h2>
      </div>
    );
  }

  return (
    <div className="profitability-stack">
      <section className="profitability-summary">
        <div>
          <span className="category">Profitability</span>
          <h2>Company-fit profit moves first, global targets second</h2>
        </div>
        <div className="profitability-notes">
          {profitability.assumptions.slice(0, 3).map((item) => <span key={item}>{item}</span>)}
          {profitability.warnings.slice(0, 2).map((item) => <span className="warning-text" key={item}>{item}</span>)}
        </div>
      </section>
      <ProfitabilityOpportunityGrid title="Company-fit now" opportunities={profitability.companyFit} />
      <ProfitabilityOpportunityGrid title="Global targets to restructure toward" opportunities={profitability.globalTargets} />
      {(profitability.chainOpportunities ?? []).length > 0 ? (
        <section className="profitability-section">
          <header>
            <h3>Production chains</h3>
            <span>{(profitability.chainOpportunities ?? []).length} chain options</span>
          </header>
          <div className="item-grid">
            {(profitability.chainOpportunities ?? []).slice(0, 4).map((opportunity) => (
              <article className="data-card wide" key={opportunity.id}>
                <header>
                  <div>
                    <span className="category">{opportunity.kind.replaceAll("_", " ")}</span>
                    <strong>{opportunity.title}</strong>
                  </div>
                  <div className="plan-badges">
                    <span className="horizon-chip">{opportunity.horizonLabel}</span>
                    <span className="profit-chip">{moneyPerHour(opportunity.profitPerHour)}</span>
                    <span className={`confidence-chip ${opportunity.confidence}`}>{opportunity.confidence}</span>
                  </div>
                </header>
                <p>{opportunity.recommendation}</p>
                <div className="evidence-list">
                  {[...opportunity.rationale, ...opportunity.blockers].slice(0, 5).map((item) => <span key={item}>{item}</span>)}
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}
      <section className="profitability-table-card">
        <header>
          <h3>Top recipe economics</h3>
          <span>{profitability.recipes.length} ranked recipes</span>
        </header>
        <div className="profitability-table" role="table" aria-label="Top recipe economics">
          <div role="row" className="profitability-row heading">
            <span>Recipe</span>
            <span>Building</span>
            <span>Profit / h</span>
            <span>Margin</span>
            <span>Input cost / h</span>
            <span>Coverage</span>
            <span>Fit</span>
          </div>
          {profitability.recipes.slice(0, 12).map((recipe) => (
            <div role="row" className="profitability-row" key={recipe.recipeId}>
              <span>
                <strong>{recipe.outputMatName}</strong>
                <small>{recipe.recipeName}</small>
              </span>
              <span>{recipe.buildingName ?? "Unknown"}</span>
              <span>{moneyPerHour(recipe.netEstimatePerHour)}</span>
              <span>{recipe.marginPct !== undefined ? `${Math.round(recipe.marginPct)}%` : "n/a"}</span>
              <span>{moneyPerHour(recipe.inputCostPerHour)}</span>
              <span>{Math.round(recipe.inputCoveragePct)}%</span>
              <span><span className={`confidence-chip ${recipe.priceConfidence}`}>{recipe.companyFit}</span></span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function ChainsPanel({ sitrep }: { sitrep: SitrepResponse }) {
  const profitability = sitrep.profitability;
  const chains = profitability?.chains ?? [];
  const opportunities = sitrep.chainOpportunities ?? profitability?.chainOpportunities ?? [];
  if (!profitability || chains.length === 0) {
    return (
      <div className="empty-state compact">
        <GitBranch size={28} />
        <h2>No chain candidates in this sitrep</h2>
        <p>Chain optimization needs at least two linked profitable recipes in game data.</p>
      </div>
    );
  }

  return (
    <div className="profitability-stack">
      <section className="profitability-summary">
        <div>
          <span className="category">Chain optimizer</span>
          <h2>Linked production paths ranked by profit, coverage, fit, and liquidity</h2>
        </div>
        <div className="profitability-notes">
          {opportunities.slice(0, 4).map((opportunity) => (
            <span key={opportunity.id}>{opportunity.title}: {moneyPerHour(opportunity.profitPerHour)}</span>
          ))}
        </div>
      </section>
      <section className="profitability-section">
        <header>
          <h3>Chain opportunities</h3>
          <span>{opportunities.length} options</span>
        </header>
        <div className="item-grid">
          {opportunities.map((opportunity) => (
            <article className="data-card wide" key={opportunity.id}>
              <header>
                <div>
                  <span className="category">{opportunity.kind.replaceAll("_", " ")}</span>
                  <strong>{opportunity.title}</strong>
                </div>
                <div className="plan-badges">
                  <span className="score-chip">{Math.round(opportunity.score)}</span>
                  <span className="profit-chip">{moneyPerHour(opportunity.profitPerHour)}</span>
                  <span className={`confidence-chip ${opportunity.confidence}`}>{opportunity.confidence}</span>
                </div>
              </header>
              <p>{opportunity.recommendation}</p>
              <dl>
                <div><dt>Horizon</dt><dd>{opportunity.horizonLabel}</dd></div>
                <div><dt>Coverage</dt><dd>{Math.round(opportunity.inputCoveragePct ?? 0)}%</dd></div>
                <div><dt>Margin</dt><dd>{opportunity.marginPct !== undefined ? `${Math.round(opportunity.marginPct)}%` : "n/a"}</dd></div>
              </dl>
              <div className="evidence-list">
                {[...opportunity.rationale, ...opportunity.blockers].slice(0, 6).map((item) => <span key={item}>{item}</span>)}
              </div>
            </article>
          ))}
        </div>
      </section>
      <section className="profitability-section">
        <header>
          <h3>Chain candidates</h3>
          <span>{chains.length} linked paths</span>
        </header>
        <div className="item-grid">
          {chains.map((chain) => (
            <article className="data-card wide" key={chain.id}>
              <header>
                <div>
                  <span className="category">{chain.companyFit} chain</span>
                  <strong>{chain.title}</strong>
                </div>
                <div className="plan-badges">
                  <span className="profit-chip">{moneyPerHour(chain.totalNetProfitPerHour)}</span>
                  <span className={`confidence-chip ${chain.confidence}`}>{chain.confidence}</span>
                </div>
              </header>
              <dl>
                <div><dt>Coverage</dt><dd>{Math.round(chain.inputCoveragePct)}%</dd></div>
                <div><dt>Liquidity</dt><dd>{Math.round(chain.liquidityScore)}</dd></div>
                <div><dt>Margin</dt><dd>{chain.marginPct !== undefined ? `${Math.round(chain.marginPct)}%` : "n/a"}</dd></div>
              </dl>
              <div className="chain-step-list">
                {chain.steps.map((step, index) => (
                  <span key={`${chain.id}-${step.recipeId}`}>{index + 1}. {step.outputMatName} ({moneyPerHour(step.netEstimatePerHour)})</span>
                ))}
              </div>
              {chain.setupGaps.length > 0 ? <p className="warning-text">{chain.setupGaps.slice(0, 4).join(" ")}</p> : null}
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function WhatIfPanel({
  sitrep,
  planning
}: {
  sitrep: SitrepResponse;
  planning: {
    userPrompt: string;
    nextLoginAt: string;
    autonomyHours: number;
    cashRiskLevel: string;
    shortTermGoal: string;
    notes: string;
  };
}) {
  const recipes = sitrep.profitability?.recipes ?? [];
  const materials = useMemo(() => {
    const byId = new globalThis.Map<number, string>();
    for (const signal of sitrep.marketSignals) byId.set(signal.matId, signal.matName);
    for (const risk of sitrep.stockoutRisks) byId.set(risk.matId, risk.matName);
    for (const recipe of recipes) {
      byId.set(recipe.outputMatId, recipe.outputMatName);
      for (const matId of recipe.inputMatIds) if (!byId.has(matId)) byId.set(matId, `Material ${matId}`);
    }
    return [...byId.entries()].map(([id, name]) => ({ id, name }));
  }, [recipes, sitrep.marketSignals, sitrep.stockoutRisks]);
  const [form, setForm] = useState({
    scenarioType: "stage_inputs" as WhatIfScenarioRequest["scenarioType"],
    recipeId: recipes[0]?.recipeId ? String(recipes[0].recipeId) : "",
    matId: materials[0]?.id ? String(materials[0].id) : "",
    quantity: "",
    cashSpend: "",
    bufferHours: "24",
    description: ""
  });
  const [result, setResult] = useState<WhatIfScenarioResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const payload: WhatIfScenarioRequest = {
        scenarioType: form.scenarioType,
        planningContext: {
          ...planning,
          autonomyHours: Number(planning.autonomyHours),
          cashRiskLevel: planning.cashRiskLevel as WhatIfScenarioRequest["planningContext"]["cashRiskLevel"],
          nextLoginAt: planning.nextLoginAt || undefined,
          userPrompt: planning.userPrompt || undefined,
          notes: planning.notes || undefined
        },
        recipeId: form.recipeId ? Number(form.recipeId) : undefined,
        matId: form.matId ? Number(form.matId) : undefined,
        quantity: form.quantity ? Number(form.quantity) : undefined,
        cashSpend: form.cashSpend ? Number(form.cashSpend) : undefined,
        bufferHours: form.bufferHours ? Number(form.bufferHours) : undefined,
        description: form.description || undefined
      };
      const response = await fetch("/api/agent/what-if", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not evaluate scenario.");
      setResult(body);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not evaluate scenario.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="whatif-layout">
      <form className="whatif-form" onSubmit={submit}>
        <div className="section-heading">
          <FlaskConical size={19} />
          <h2>Scenario planner</h2>
        </div>
        <div className="context-grid">
          <label>
            Scenario
            <select value={form.scenarioType} onChange={(event) => setForm({ ...form, scenarioType: event.target.value as WhatIfScenarioRequest["scenarioType"] })}>
              <option value="stage_inputs">Stage inputs</option>
              <option value="start_recipe">Start recipe</option>
              <option value="switch_production">Switch production</option>
              <option value="buy_material">Buy material</option>
              <option value="increase_buffer">Increase buffer</option>
              <option value="build_expansion">Build / expand</option>
            </select>
          </label>
          <label>
            Recipe
            <select value={form.recipeId} onChange={(event) => setForm({ ...form, recipeId: event.target.value })}>
              <option value="">Auto</option>
              {recipes.slice(0, 30).map((recipe) => (
                <option key={recipe.recipeId} value={recipe.recipeId}>{recipe.outputMatName} ({recipe.recipeId})</option>
              ))}
            </select>
          </label>
          <label>
            Material
            <select value={form.matId} onChange={(event) => setForm({ ...form, matId: event.target.value })}>
              <option value="">Auto</option>
              {materials.map((material) => (
                <option key={material.id} value={material.id}>{material.name} ({material.id})</option>
              ))}
            </select>
          </label>
          <label>
            Quantity
            <input type="number" min="0" value={form.quantity} onChange={(event) => setForm({ ...form, quantity: event.target.value })} placeholder="Auto" />
          </label>
        </div>
        <div className="field-row">
          <label>
            Cash spend override
            <input type="number" min="0" value={form.cashSpend} onChange={(event) => setForm({ ...form, cashSpend: event.target.value })} placeholder="Auto" />
          </label>
          <label>
            Buffer hours
            <input type="number" min="1" max="168" value={form.bufferHours} onChange={(event) => setForm({ ...form, bufferHours: event.target.value })} />
          </label>
        </div>
        <label>
          Scenario note
          <textarea value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
        </label>
        {error ? <p className="error-line">{error}</p> : null}
        <button className="primary-button run-button" type="submit" disabled={loading}>
          {loading ? <Loader2 className="spin" size={18} /> : <FlaskConical size={18} />}
          Compare Scenario
        </button>
      </form>
      {result ? <WhatIfResultCards result={result} /> : (
        <section className="whatif-result empty">
          <h2>Baseline vs scenario</h2>
          <p>Choose a scenario to compare cash impact, projected profit, material deltas, risk, and blockers without changing in-game state.</p>
        </section>
      )}
    </div>
  );
}

function WhatIfResultCards({ result }: { result: WhatIfScenarioResult }) {
  return (
    <section className="whatif-result">
      <header>
        <div>
          <span className="category">{result.scenarioType.replaceAll("_", " ")}</span>
          <h2>{result.title}</h2>
        </div>
        <span className={`tag ${result.recommendedChoice === "scenario" ? "buy" : result.recommendedChoice === "defer" ? "watch" : "avoid"}`}>
          {result.recommendedChoice}
        </span>
      </header>
      <div className="comparison-grid">
        <ScenarioCard label="Baseline" state={result.baseline} />
        <ScenarioCard label="Scenario" state={result.scenario} />
      </div>
      <div className="decision-grid">
        <article>
          <h3>Delta</h3>
          <p>Cash: {result.deltas.cash !== undefined ? moneyDelta(result.deltas.cash) : "n/a"}</p>
          <p>Profit: {result.deltas.profitPerHour !== undefined ? `${moneyDelta(result.deltas.profitPerHour)}/h` : "n/a"}</p>
          {result.deltas.materials.map((delta) => (
            <p key={delta.matId}>{delta.matName}: {delta.quantityDelta.toLocaleString()} units</p>
          ))}
        </article>
        <article>
          <h3>Rationale</h3>
          <ul>{result.rationale.map((item) => <li key={item}>{item}</li>)}</ul>
        </article>
        <details>
          <summary>Prepared manual steps</summary>
          {result.preparedCommands.length === 0 ? <p>No prepared command for this scenario.</p> : (
            <ol>{result.preparedCommands.flatMap((command) => command.steps).map((step) => <li key={step}>{step}</li>)}</ol>
          )}
        </details>
      </div>
      {result.blockers.length > 0 ? <p className="warning-text">{result.blockers.join(" ")}</p> : null}
    </section>
  );
}

function ScenarioCard({ label, state }: { label: string; state: WhatIfScenarioResult["baseline"] }) {
  return (
    <article className="data-card">
      <header>
        <div>
          <span className="category">{label}</span>
          <strong>{state.title}</strong>
        </div>
        <span className={`priority ${state.risk}`}>{state.risk}</span>
      </header>
      <p>{state.summary}</p>
      <dl>
        <div><dt>Cash</dt><dd>{state.cashDisplay ?? "n/a"}</dd></div>
        <div><dt>Profit / h</dt><dd>{state.profitPerHourDisplay ?? "n/a"}</dd></div>
        <div><dt>Blockers</dt><dd>{state.blockers.length}</dd></div>
      </dl>
      {state.productionImpact.length > 0 ? (
        <div className="evidence-list">
          {state.productionImpact.slice(0, 5).map((item) => <span key={item}>{item}</span>)}
        </div>
      ) : null}
    </article>
  );
}

function ProfitabilityOpportunityGrid({ title, opportunities }: { title: string; opportunities: NonNullable<SitrepResponse["profitability"]>["companyFit"] }) {
  return (
    <section className="profitability-section">
      <header>
        <h3>{title}</h3>
        <span>{opportunities.length} options</span>
      </header>
      <div className="item-grid">
        {opportunities.length === 0 ? (
          <article className="data-card wide">
            <strong>No option cleared the filters</strong>
            <p>Use the raw snapshot or a fresh run after production/market state changes.</p>
          </article>
        ) : opportunities.map((opportunity) => (
          <article className="data-card wide" key={opportunity.id}>
            <header>
              <div>
                <span className="category">{opportunity.kind.replaceAll("_", " ")}</span>
                <strong>{opportunity.title}</strong>
              </div>
              <div className="plan-badges">
                <span className="horizon-chip">{opportunity.horizonLabel}</span>
                <span className="profit-chip">{moneyPerHour(opportunity.profitPerHour)}</span>
                <span className={`confidence-chip ${opportunity.confidence}`}>{opportunity.confidence}</span>
              </div>
            </header>
            <p>{opportunity.recommendation}</p>
            <dl>
              <div><dt>Score</dt><dd>{Math.round(opportunity.score)}</dd></div>
              <div><dt>Margin</dt><dd>{opportunity.marginPct !== undefined ? `${Math.round(opportunity.marginPct)}%` : "n/a"}</dd></div>
              <div><dt>Recipe</dt><dd>{opportunity.recipeId}</dd></div>
            </dl>
            <div className="evidence-list">
              {[...opportunity.rationale, ...opportunity.blockers].slice(0, 5).map((item) => <span key={item}>{item}</span>)}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function DecisionBriefPanel({ brief }: { brief: SitrepResponse["decisionBrief"] }) {
  return (
    <section className="decision-brief" aria-label="Decision Brief">
      <div className="decision-brief-head">
        <div>
          <span className="category">Decision brief</span>
          <h2>{brief.thesis}</h2>
        </div>
        <span className={`confidence-chip ${brief.confidence}`}>{brief.confidence}</span>
      </div>
      <div className="decision-grid">
        <article>
          <h3>Recommended path</h3>
          <ol>{brief.recommendedPath.map((item) => <li key={item}>{item}</li>)}</ol>
        </article>
        <article>
          <h3>Why this path</h3>
          <ul>{brief.whyThisPath.slice(0, 4).map((item) => <li key={item}>{item}</li>)}</ul>
        </article>
        <details>
          <summary>Alternatives</summary>
          <div className="brief-detail-list">
            {brief.alternatives.map((alternative) => (
              <section key={alternative.title}>
                <h4>{alternative.title}</h4>
                <p><strong>Choose when:</strong> {alternative.chooseWhen}</p>
                {alternative.pros.length > 0 ? <p><strong>Pros:</strong> {alternative.pros.join(" ")}</p> : null}
                {alternative.cons.length > 0 ? <p><strong>Cons:</strong> {alternative.cons.join(" ")}</p> : null}
              </section>
            ))}
          </div>
        </details>
        <details>
          <summary>Constraints</summary>
          <ul>{brief.constraints.map((item) => <li key={item}>{item}</li>)}</ul>
        </details>
        <details>
          <summary>Inspect next</summary>
          <ul>{brief.inspectNext.map((item) => <li key={item}>{item}</li>)}</ul>
        </details>
      </div>
    </section>
  );
}

function SituationGrid({ situation }: { situation: NonNullable<SitrepResponse["situation"]> }) {
  const rows: Array<[string, PressureSummary]> = [
    ["Cash", situation.cash],
    ["Production", situation.production],
    ["Logistics", situation.logistics],
    ["Market", situation.market],
    ["Expansion", situation.expansion],
    ["Data", situation.dataQuality]
  ];

  return (
    <div className="situation-grid">
      {rows.map(([label, item]) => (
        <div key={label}>
          <span>{label}</span>
          <strong className={`pressure ${item.status}`}>{item.status}</strong>
          <p>{item.summary}</p>
        </div>
      ))}
    </div>
  );
}

function money(cents: number) {
  if (cents < 0) return "n/a";
  return `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function moneyPerHour(cents: number) {
  return `${money(cents)}/h`;
}

function moneyDelta(cents: number) {
  const sign = cents >= 0 ? "+" : "-";
  return `${sign}$${(Math.abs(cents) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}
