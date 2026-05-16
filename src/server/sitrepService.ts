import { buildDeterministicSitrep } from "./analysis.js";
import type { GalacticTycoonsClient } from "./gtClient.js";
import type { LlmPlanner } from "./llm/providers.js";
import { LlmProviderError } from "./llm/providers.js";
import { MissingProviderKeyError, type AgentSession, type SessionStore } from "./sessionStore.js";
import type { SitrepRequest, SitrepResponse } from "../shared/schemas.js";

export class SitrepService {
  constructor(
    private readonly gtClient: GalacticTycoonsClient,
    private readonly llmPlanner: LlmPlanner,
    private readonly sessions: SessionStore
  ) {}

  async generate(session: AgentSession, request: SitrepRequest): Promise<SitrepResponse> {
    const totalStartedAt = Date.now();
    const snapshot = await this.gtClient.getSnapshot(session, request.refresh);
    const snapshotMs = Date.now() - totalStartedAt;
    const deterministic = buildDeterministicSitrep(snapshot, request.planningContext, request.provider, request.model);
    const deterministicMs = Date.now() - totalStartedAt - snapshotMs;
    const llmStartedAt = Date.now();

    try {
      const providerApiKey = this.sessions.requireProviderKey(session, request.provider);
      const response = await this.llmPlanner.generateStructuredPlan({
        provider: request.provider,
        model: request.model,
        providerApiKey,
        planningContext: request.planningContext,
        snapshot,
        deterministicSitrep: deterministic
      });

      return {
        ...response,
        diagnostics: {
          source: "llm",
          timingsMs: {
            snapshot: snapshotMs,
            deterministic: deterministicMs,
            llm: Date.now() - llmStartedAt,
            total: Date.now() - totalStartedAt
          }
        }
      };
    } catch (error) {
      if (error instanceof LlmProviderError || error instanceof MissingProviderKeyError) {
        const llmMessage = error instanceof MissingProviderKeyError
          ? `No ${request.provider} API key is stored in this session. Start a new session with that provider key to use the model.`
          : error.message;
        return {
          ...deterministic,
          diagnostics: {
            source: "deterministic",
            timingsMs: {
              snapshot: snapshotMs,
              deterministic: deterministicMs,
              llm: Date.now() - llmStartedAt,
              total: Date.now() - totalStartedAt
            },
            llmMessage
          },
          warnings: [...deterministic.warnings, `LLM provider unavailable or invalid; showing deterministic sitrep. ${llmMessage}`]
        };
      }
      throw error;
    }
  }
}
