import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BarChart3,
  Boxes,
  Brain,
  CheckCircle2,
  ClipboardList,
  Factory,
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
import type { ModelCatalogResponse, ModelOption, Provider, SitrepResponse } from "../shared/schemas.js";

type Tab = "sitrep" | "market" | "operations" | "logistics" | "expansion" | "raw";

const providerLabels: Record<Provider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Gemini"
};

const defaultModels: Record<Provider, string> = {
  openai: "gpt-5.5",
  anthropic: "claude-sonnet-4-6",
  gemini: "gemini-3.1-pro-preview"
};

const fallbackModelOptions: Record<Provider, ModelOption[]> = {
  openai: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-4.1"].map((id) => ({ id, label: id, source: "fallback" })),
  anthropic: ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5"].map((id) => ({ id, label: id, source: "fallback" })),
  gemini: ["gemini-3.1-pro-preview", "gemini-3-flash-preview", "gemini-3.1-flash-lite", "gemini-2.5-pro", "gemini-2.5-flash"].map((id) => ({ id, label: id, source: "fallback" }))
};

const tabs: Array<{ id: Tab; label: string; icon: typeof ClipboardList }> = [
  { id: "sitrep", label: "Sitrep", icon: ClipboardList },
  { id: "market", label: "Market", icon: BarChart3 },
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
              {!sitrep ? <EmptyState loading={runLoading} /> : <DashboardTab tab={activeTab} sitrep={sitrep} />}
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

function DashboardTab({ tab, sitrep }: { tab: Tab; sitrep: SitrepResponse }) {
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
              <div><dt>Trend</dt><dd>{signal.trend}</dd></div>
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
        {sitrep.diagnostics ? (
          <div className="diagnostic-row">
            <span>Pipeline: {sitrep.diagnostics.source}</span>
            <span>GT {Math.round(sitrep.diagnostics.timingsMs.snapshot ?? 0)} ms</span>
            <span>LLM {Math.round(sitrep.diagnostics.timingsMs.llm ?? 0)} ms</span>
            <span>Total {Math.round(sitrep.diagnostics.timingsMs.total ?? 0)} ms</span>
          </div>
        ) : null}
      </section>
      <div className="action-list">
        {sitrep.actionPlans.map((plan) => (
          <article className="action-card" key={plan.id}>
            <header>
              <div>
                <span className="category">{plan.category}</span>
                <h3>{plan.title}</h3>
              </div>
              <span className={`priority ${plan.priority}`}>{plan.priority}</span>
            </header>
            <div className="action-copy">
              <p><strong>Benefit:</strong> {plan.expectedBenefit}</p>
              <p><strong>Cost:</strong> {plan.costSummary}</p>
              <p><strong>Risk:</strong> {plan.risk}</p>
            </div>
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

function money(cents: number) {
  if (cents < 0) return "n/a";
  return `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}
