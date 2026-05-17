import { buildDeterministicSitrep } from "./analysis.js";
import type { GalacticTycoonsClient } from "./gtClient.js";
import { StrategyHistoryStore } from "./historyStore.js";
import type { LlmPlanner } from "./llm/providers.js";
import type { AgentSession, SessionStore } from "./sessionStore.js";
import type { RefreshOptions, SitrepRequest, SitrepResponse } from "../shared/schemas.js";

const DEFAULT_SITREP_REFRESH: RefreshOptions = {
  forceCompany: true,
  forceMarket: true,
  forceGameData: false
};

export class SitrepService {
  constructor(
    private readonly gtClient: GalacticTycoonsClient,
    private readonly llmPlanner: LlmPlanner,
    private readonly sessions: SessionStore,
    private readonly history: StrategyHistoryStore = new StrategyHistoryStore()
  ) {}

  async generate(session: AgentSession, request: SitrepRequest): Promise<SitrepResponse> {
    const totalStartedAt = Date.now();
    const snapshot = await this.gtClient.getSnapshot(session, {
      ...DEFAULT_SITREP_REFRESH,
      ...request.refresh
    });
    const snapshotMs = Date.now() - totalStartedAt;
    const historyBeforeRun = this.history.summary(session.id);
    const deterministicBase = buildDeterministicSitrep(snapshot, request.planningContext, request.provider, request.model);
    const deterministic = {
      ...deterministicBase,
      history: historyBeforeRun,
      trendSignals: historyBeforeRun.trendSignals,
      chainOpportunities: deterministicBase.profitability?.chainOpportunities ?? []
    };
    const deterministicMs = Date.now() - totalStartedAt - snapshotMs;
    const llmStartedAt = Date.now();

    const providerApiKey = this.sessions.requireProviderKey(session, request.provider);
    const response = await this.llmPlanner.generateStructuredPlan({
      provider: request.provider,
      model: request.model,
      providerApiKey,
      planningContext: request.planningContext,
      snapshot,
      deterministicSitrep: deterministic
    });

    const responseWithDiagnostics: SitrepResponse = {
      ...response,
      diagnostics: {
        ...response.diagnostics,
        source: "llm",
        timingsMs: {
          snapshot: snapshotMs,
          deterministic: deterministicMs,
          llm: Date.now() - llmStartedAt,
          total: Date.now() - totalStartedAt
        }
      }
    };
    const updatedHistory = this.history.record(session.id, responseWithDiagnostics);

    return {
      ...responseWithDiagnostics,
      history: updatedHistory,
      trendSignals: updatedHistory.trendSignals,
      chainOpportunities: responseWithDiagnostics.profitability?.chainOpportunities ?? responseWithDiagnostics.chainOpportunities ?? []
    };
  }
}
