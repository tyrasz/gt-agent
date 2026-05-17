import { TtlCache } from "./cache.js";
import { MissingProviderKeyError, type AgentSession } from "./sessionStore.js";
import type { ModelCatalogResponse, ModelOption, Provider } from "../shared/schemas.js";

const MODEL_CATALOG_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MODEL_FETCH_TIMEOUT_MS = 15_000;

type FetchLike = typeof fetch;

export type ModelCatalogOptions = {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  ttlMs?: number;
};

export class ModelCatalogService {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly ttlMs: number;
  private readonly cache = new TtlCache<ModelCatalogResponse>();

  constructor(options: ModelCatalogOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? Number(process.env.MODEL_CATALOG_TIMEOUT_MS ?? DEFAULT_MODEL_FETCH_TIMEOUT_MS);
    this.ttlMs = options.ttlMs ?? MODEL_CATALOG_TTL_MS;
  }

  async listModels(session: AgentSession, provider: Provider, refresh = false): Promise<ModelCatalogResponse> {
    const cacheKey = `${session.id}:${provider}`;
    const cached = refresh ? undefined : this.cache.get(cacheKey);
    if (cached) return cached;

    const providerApiKey = session.providerKeys[provider];
    if (!providerApiKey) throw new MissingProviderKeyError(provider);

    let catalog: ModelCatalogResponse;
    try {
      const models = await this.fetchProviderModels(provider, providerApiKey);
      const usableModels = models.length > 0 ? models : fallbackModels(provider);
      catalog = {
        provider,
        defaultModel: chooseDefaultModel(provider, usableModels),
        models: usableModels,
        warnings: models.length > 0 ? [] : [`${providerLabel(provider)} did not return any compatible text models; using fallback model list.`]
      };
    } catch (error) {
      const fallback = fallbackModels(provider);
      catalog = {
        provider,
        defaultModel: fallback[0].id,
        models: fallback,
        warnings: [`Could not load ${providerLabel(provider)} models: ${describeModelError(error)}. Using fallback model list.`]
      };
    }

    this.cache.set(cacheKey, catalog, this.ttlMs);
    return catalog;
  }

  private async fetchProviderModels(provider: Provider, providerApiKey: string): Promise<ModelOption[]> {
    if (provider === "openai") return this.fetchOpenAiModels(providerApiKey);
    if (provider === "anthropic") return this.fetchAnthropicModels(providerApiKey);
    return this.fetchGeminiModels(providerApiKey);
  }

  private async fetchOpenAiModels(providerApiKey: string): Promise<ModelOption[]> {
    const body = await this.fetchJson<{ data?: Array<Record<string, unknown>> }>(
      "openai",
      "https://api.openai.com/v1/models",
      { headers: { Authorization: `Bearer ${providerApiKey}` } }
    );
    return uniqueModels((body.data ?? [])
      .map((model) => String(model.id ?? ""))
      .filter(isOpenAiSitrepModel)
      .map((id) => ({ id, label: id, source: "provider" as const })))
      .sort((a, b) => comparePreferred("openai", a.id, b.id));
  }

  private async fetchAnthropicModels(providerApiKey: string): Promise<ModelOption[]> {
    const body = await this.fetchJson<{ data?: Array<Record<string, unknown>> }>(
      "anthropic",
      "https://api.anthropic.com/v1/models?limit=1000",
      {
        headers: {
          "x-api-key": providerApiKey,
          "anthropic-version": "2023-06-01"
        }
      }
    );
    return uniqueModels((body.data ?? [])
      .map((model) => ({
        id: String(model.id ?? ""),
        label: typeof model.display_name === "string" ? model.display_name : String(model.id ?? ""),
        source: "provider" as const
      }))
      .filter((model) => isAnthropicSitrepModel(model.id)))
      .sort((a, b) => comparePreferred("anthropic", a.id, b.id));
  }

  private async fetchGeminiModels(providerApiKey: string): Promise<ModelOption[]> {
    const body = await this.fetchJson<{ models?: Array<Record<string, unknown>> }>(
      "gemini",
      `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(providerApiKey)}`,
      {}
    );
    return uniqueModels((body.models ?? [])
      .map((model) => {
        const id = normalizeGeminiModelId(model);
        return {
          id,
          label: typeof model.displayName === "string" ? model.displayName : id,
          source: "provider" as const,
          supportedActions: model.supportedGenerationMethods ?? model.supportedActions ?? model.supported_actions
        };
      })
      .filter((model) => isGeminiSitrepModel(model.id, model.supportedActions))
      .map(({ id, label, source }) => ({ id, label, source })))
      .sort((a, b) => comparePreferred("gemini", a.id, b.id));
  }

  private async fetchJson<T>(provider: Provider, url: string, init: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;

    try {
      response = await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (isAbortError(error)) {
        throw new Error(`${providerLabel(provider)} model list timed out after ${Math.round(this.timeoutMs / 1000)}s`);
      }
      throw new Error(`${providerLabel(provider)} model list request failed`);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new Error(`${providerLabel(provider)} model API returned ${response.status}`);
    }

    return (await response.json()) as T;
  }
}

function fallbackModels(provider: Provider): ModelOption[] {
  return fallbackIds[provider].map((id) => ({ id, label: id, source: "fallback" }));
}

function chooseDefaultModel(provider: Provider, models: ModelOption[]): string {
  const ids = new Set(models.map((model) => model.id));
  return preferredIds[provider].find((id) => ids.has(id)) ?? models[0]?.id ?? fallbackIds[provider][0];
}

function comparePreferred(provider: Provider, a: string, b: string): number {
  const preferred = preferredIds[provider];
  const indexA = preferred.indexOf(a);
  const indexB = preferred.indexOf(b);
  if (indexA >= 0 || indexB >= 0) {
    return (indexA >= 0 ? indexA : Number.MAX_SAFE_INTEGER) - (indexB >= 0 ? indexB : Number.MAX_SAFE_INTEGER);
  }
  return a.localeCompare(b);
}

function uniqueModels(models: ModelOption[]): ModelOption[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    if (!model.id || seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}

function isOpenAiSitrepModel(id: string): boolean {
  if (!id) return false;
  const lower = id.toLowerCase();
  const blocked = ["audio", "codex", "computer-use", "dall", "embedding", "image", "moderation", "realtime", "search", "sora", "transcribe", "tts", "whisper"];
  if (blocked.some((part) => lower.includes(part))) return false;
  return lower.startsWith("gpt-") || /^o\d/.test(lower);
}

function isAnthropicSitrepModel(id: string): boolean {
  return id.toLowerCase().startsWith("claude-");
}

function isGeminiSitrepModel(id: string, supportedActions: unknown): boolean {
  if (!id) return false;
  const lower = id.toLowerCase();
  const blocked = ["embedding", "imagen", "image", "live", "lyria", "robotics", "tts", "veo"];
  if (!lower.startsWith("gemini-") || blocked.some((part) => lower.includes(part))) return false;
  const actions = Array.isArray(supportedActions) ? supportedActions.map(String) : [];
  return actions.length === 0 || actions.includes("generateContent");
}

function normalizeGeminiModelId(model: Record<string, unknown>): string {
  const name = String(model.name ?? model.baseModelId ?? "");
  return name.startsWith("models/") ? name.slice("models/".length) : name;
}

function providerLabel(provider: Provider): string {
  if (provider === "openai") return "OpenAI";
  if (provider === "anthropic") return "Anthropic";
  return "Gemini";
}

function describeModelError(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

const preferredIds: Record<Provider, string[]> = {
  openai: ["gpt-5-mini", "gpt-4.1-mini", "gpt-4o-mini", "gpt-5-nano", "gpt-5.2", "gpt-5.1", "gpt-5", "gpt-5-pro", "gpt-4.1", "gpt-4o", "o4-mini", "o3"],
  anthropic: ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-4-1", "claude-sonnet-4"],
  gemini: ["gemini-3.1-pro-preview", "gemini-3-flash-preview", "gemini-3.1-flash-lite", "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"]
};

const fallbackIds: Record<Provider, string[]> = {
  openai: ["gpt-4.1-mini", "gpt-4o-mini", "gpt-5-mini", "gpt-5-nano", "gpt-5", "gpt-4.1", "gpt-4o"],
  anthropic: ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5"],
  gemini: ["gemini-3.1-pro-preview", "gemini-3-flash-preview", "gemini-3.1-flash-lite", "gemini-2.5-pro", "gemini-2.5-flash"]
};
