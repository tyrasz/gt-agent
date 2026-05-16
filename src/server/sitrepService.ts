import { buildDeterministicSitrep } from "./analysis.js";
import type { GalacticTycoonsClient } from "./gtClient.js";
import type { LlmPlanner } from "./llm/providers.js";
import { LlmProviderError } from "./llm/providers.js";
import type { AgentSession, SessionStore } from "./sessionStore.js";
import type { SitrepRequest, SitrepResponse } from "../shared/schemas.js";

export class SitrepService {
  constructor(
    private readonly gtClient: GalacticTycoonsClient,
    private readonly llmPlanner: LlmPlanner,
    private readonly sessions: SessionStore
  ) {}

  async generate(session: AgentSession, request: SitrepRequest): Promise<SitrepResponse> {
    const snapshot = await this.gtClient.getSnapshot(session, request.refresh);
    const deterministic = buildDeterministicSitrep(snapshot, request.planningContext, request.provider, request.model);
    const providerApiKey = this.sessions.requireProviderKey(session, request.provider);

    try {
      return await this.llmPlanner.generateStructuredPlan({
        provider: request.provider,
        model: request.model,
        providerApiKey,
        planningContext: request.planningContext,
        snapshot,
        deterministicSitrep: deterministic
      });
    } catch (error) {
      if (error instanceof LlmProviderError) {
        return {
          ...deterministic,
          warnings: [...deterministic.warnings, `LLM provider unavailable or invalid; showing deterministic sitrep. ${error.message}`]
        };
      }
      throw error;
    }
  }
}
